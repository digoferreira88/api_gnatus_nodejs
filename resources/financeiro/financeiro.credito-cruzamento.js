// GET /financeiro/credito-cruzamento?doc=&cod=&loja=&exceto=&secoes=analises,cobranca,credito360
//
// Tudo o que a casa já sabe sobre um CPF/CNPJ, para a análise de crédito não ser
// feita em duplicidade:
//   - analises: registros de análise VIGENTES do documento (+ legados sem CPF/CNPJ
//     mas com o mesmo código de cliente), alerta de duplicidade (janela de
//     JANELA_DUPLICIDADE_DIAS) e as condições liberadas que ainda valem;
//     mesmaRaiz = outras filiais (mesma raiz de CNPJ).
//   - clientes: cadastros do documento no Protheus (SA1 — pode haver várias lojas).
//   - cobranca: títulos em aberto/vencidos (SE1), status de cobrança do cliente e
//     dos títulos, últimas ações — mesma régua do Cliente 360 da Cobrança.
//   - credito360: resumo do Crédito 360 (score, decisão, limite calculado) da loja
//     principal — sem parecer de IA e sem gravar histórico.
//
// `doc` OU `cod`(+`loja`). `exceto` = grupo em edição (fica fora do alerta).
// Perms: 8006/8007 (Registros), 15100 (Crédito 360), 9001-9003 (Cobrança). O
// parecer e o resumo do 360 só vão para quem é do crédito (8006/8007/15100).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006, 8007, 15100, 9001, 9002, 9003]);
const CR = require('../../services/creditoRegistro');
const CreditoAnalise = require('../../services/creditoAnalise');
const { STATUS_LIST } = require('../../services/cobrancaStatus');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const STATUS_LABEL = Object.fromEntries(STATUS_LIST.map((s) => [s.value, s.label]));
const MAX_LOJAS = 20;

module.exports = (app) => ({
  verb: 'get',
  route: '/credito-cruzamento',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    const q = req.query || {};

    let doc = CR.soDig(q.doc);
    const codIn = trim(q.cod).slice(0, 20);
    const lojaIn = trim(q.loja).slice(0, 10);
    const exceto = Number(q.exceto) > 0 ? Number(q.exceto) : 0;
    if (doc && !CR.tipoDocumento(doc)) return res.status(400).json({ message: 'CPF/CNPJ inválido — informe 11 ou 14 dígitos.' });
    if (!doc && !codIn) return res.status(400).json({ message: 'Informe o CPF/CNPJ ou o código do cliente.' });

    const secoesPedidas = trim(q.secoes) ? new Set(trim(q.secoes).split(',').map(trim)) : null;
    const quer = (s) => !secoesPedidas || secoesPedidas.has(s);

    try {
      // Permissões do usuário — decidem o que cada seção mostra.
      const pr = await Pg.connectAndQuery(
        `SELECT id_permissao FROM tab_intranet_usr_permissoes WHERE id_user = @id`, { id: user.ID });
      const perms = new Set(pr.map((r) => Number(r.id_permissao)));
      const tem = (...l) => perms.has(0) || l.some((p) => perms.has(p));
      const doCredito = tem(8006, 8007, 15100);
      const erros = {};

      // 1) Cadastro no Protheus: pelo documento, ou pelo código (descobre o documento).
      // Só o histórico de análises com o documento em mãos dispensa o Protheus.
      let clientes = [];
      const precisaSA1 = quer('cobranca') || quer('credito360') || !doc;
      if (precisaSA1) try {
        if (!doc && codIn) {
          const r = await Protheus.connectAndQuery(`
            SELECT TOP 1 RTRIM(A1_CGC) cgc FROM SA1010 WITH (NOLOCK)
             WHERE D_E_L_E_T_ <> '*' AND A1_COD = @cod ${lojaIn ? 'AND A1_LOJA = @loja' : ''}
             ORDER BY A1_LOJA`, { cod: codIn, loja: lojaIn });
          const d = CR.soDig(r[0] && r[0].cgc);
          if (CR.tipoDocumento(d)) doc = d;
        }
        const filtro = doc
          ? `REPLACE(REPLACE(REPLACE(RTRIM(A1_CGC), '.', ''), '/', ''), '-', '') = @doc`
          : `A1_COD = @cod ${lojaIn ? 'AND A1_LOJA = @loja' : ''}`;
        const rows = await Protheus.connectAndQuery(`
          SELECT TOP ${MAX_LOJAS * 3} RTRIM(A1_COD) cod, RTRIM(A1_LOJA) loja, RTRIM(A1_NOME) nome,
                 RTRIM(A1_NREDUZ) fantasia, RTRIM(A1_EST) uf, RTRIM(A1_MUN) municipio,
                 RTRIM(ISNULL(A1_MSBLQL, '')) bloqueado, A1_LC limite
            FROM SA1010 WITH (NOLOCK)
           WHERE D_E_L_E_T_ <> '*' AND ${filtro}
           ORDER BY A1_COD, A1_LOJA`, { doc, cod: codIn, loja: lojaIn });
        // A SA1 é cadastrada por filial: a mesma loja pode vir repetida.
        const vistos = new Set();
        rows.forEach((c) => {
          const k = `${trim(c.cod)}|${trim(c.loja)}`;
          if (vistos.has(k) || clientes.length >= MAX_LOJAS) return;
          vistos.add(k);
          clientes.push({
            cod: trim(c.cod), loja: trim(c.loja), nome: trim(c.nome), fantasia: trim(c.fantasia),
            uf: trim(c.uf), municipio: trim(c.municipio), bloqueado: trim(c.bloqueado) === '1', limite: N(c.limite)
          });
        });
      } catch (e) {
        console.error('credito-cruzamento SA1:', e.message);
        erros.protheus = 'Protheus indisponível — dados de cadastro, cobrança e 360 não carregados.';
      }

      const cods = [...new Set([...clientes.map((c) => c.cod), codIn].filter(Boolean))];

      // 2) Análises registradas do documento (+ legados sem documento com o mesmo código).
      // Sem documento conhecido (cliente sem CPF/CNPJ ou Protheus fora), vale o código.
      let analises = [], mesmaRaiz = [];
      if (quer('analises')) {
        const rows = await Pg.connectAndQuery(`
          SELECT ${CR.COLS}
            FROM tab_credito_registro r
           WHERE r.vigente AND r.grupo_id <> @exceto::int
             AND (r.documento = @doc
                  OR (r.cliente_cod = ANY(@cods::varchar[]) AND (r.documento IS NULL OR @semDoc::boolean)))
           ORDER BY r.criado_em DESC
           LIMIT 50`, { doc: doc || '-', cods, exceto, semDoc: !doc });
        analises = rows.map(CR.mapRegistro);
        if (doc.length === 14) {
          const rr = await Pg.connectAndQuery(`
            SELECT ${CR.COLS}
              FROM tab_credito_registro r
             WHERE r.vigente AND length(r.documento) = 14 AND left(r.documento, 8) = @raiz
               AND r.documento <> @doc AND r.grupo_id <> @exceto::int
             ORDER BY r.criado_em DESC
             LIMIT 20`, { raiz: doc.slice(0, 8), doc, exceto });
          mesmaRaiz = rr.map(CR.mapRegistro);
        }
      }
      const limiteJanela = Date.now() - CR.JANELA_DUPLICIDADE_DIAS * 864e5;
      const recentes = analises.filter((a) => new Date(a.criadoEm).getTime() >= limiteJanela);
      const ultima = analises[0] || null;
      const condicoesVigentes = CR.condicoesVigentes(analises);
      let alerta = null;
      if (recentes.length) {
        alerta = {
          nivel: 'duplicidade',
          texto: `Este CPF/CNPJ já tem ${recentes.length} análise(s) nos últimos ${CR.JANELA_DUPLICIDADE_DIAS} dias. ` +
            'Confira a análise e as condições já liberadas antes de registrar outra — para corrigir uma análise, edite-a (gera nova versão).'
        };
      } else if (analises.length) {
        alerta = { nivel: 'historico', texto: `Já analisado antes: ${analises.length} análise(s), a última há mais de ${CR.JANELA_DUPLICIDADE_DIAS} dias.` };
      }

      // 3) Cobrança e 360 em paralelo (só com Protheus no ar e cliente cadastrado).
      const pares = clientes.slice(0, MAX_LOJAS);
      const tarefaCobranca = (async () => {
        if (!quer('cobranca') || !pares.length || erros.protheus) return null;
        const params = {};
        const cond = pares.map((c, i) => { params[`c${i}`] = c.cod; params[`l${i}`] = c.loja; return `(E1_CLIENTE = @c${i} AND E1_LOJA = @l${i})`; }).join(' OR ');
        const tits = await Protheus.connectAndQuery(`
          SELECT TOP 3000 RTRIM(E1_CLIENTE) cod, RTRIM(E1_LOJA) loja,
                 RTRIM(E1_PREFIXO) prefixo, RTRIM(E1_NUM) numero, RTRIM(E1_PARCELA) parcela, RTRIM(E1_TIPO) tipo,
                 E1_SALDO saldo, DATEDIFF(day, CONVERT(date, E1_VENCREA, 112), GETDATE()) diasAtraso
            FROM SE1010 WITH (NOLOCK)
           WHERE D_E_L_E_T_ <> '*' AND E1_SALDO > 0 AND RTRIM(E1_TIPO) NOT IN ('RA', 'NCC')
             AND (${cond})`, params);

        const [stCli, stTit, acoes] = await Promise.all([
          Pg.connectAndQuery(`
            SELECT s.cliente_cod, s.cliente_loja, s.status, s.observacao, s.dt_atualizacao, u.nome AS user_nome
              FROM tab_cobranca_status_cliente s
              LEFT JOIN tab_intranet_usr u ON u.id = s.id_user
             WHERE s.cliente_cod = ANY(@cods::varchar[])`, { cods }),
          Pg.connectAndQuery(`
            SELECT cliente_cod, cliente_loja, titulo_prefixo, titulo_num, titulo_parcela, titulo_tipo, status
              FROM tab_cobranca_status_titulo
             WHERE cliente_cod = ANY(@cods::varchar[])`, { cods }),
          Pg.connectAndQuery(`
            SELECT a.cliente_cod, a.cliente_loja, a.tipo_acao, a.resultado, a.descricao, a.criado_em, u.nome AS user_nome
              FROM tab_cobranca_acao a
              LEFT JOIN tab_intranet_usr u ON u.id = a.id_user
             WHERE a.cliente_cod = ANY(@cods::varchar[])
             ORDER BY a.criado_em DESC
             LIMIT 3`, { cods })
        ]);

        const lojasDoDoc = new Set(pares.map((c) => `${c.cod}|${c.loja}`));
        const daLoja = (r) => lojasDoDoc.has(`${trim(r.cliente_cod)}|${trim(r.cliente_loja)}`);
        const chaveTit = (cod, loja, p, n, pa, t) => [cod, loja, p, n, pa, t].map(trim).join('|');
        const abertos = new Set(tits.map((t) => chaveTit(t.cod, t.loja, t.prefixo, t.numero, t.parcela, t.tipo)));

        const porLoja = new Map();
        tits.forEach((t) => {
          const k = `${t.cod}|${t.loja}`;
          const o = porLoja.get(k) || { cod: t.cod, loja: t.loja, qtd: 0, saldo: 0, qtdVencido: 0, vencido: 0, maiorAtraso: 0 };
          const d = N(t.diasAtraso);
          o.qtd += 1; o.saldo += N(t.saldo);
          if (d > 0) { o.qtdVencido += 1; o.vencido += N(t.saldo); o.maiorAtraso = Math.max(o.maiorAtraso, d); }
          porLoja.set(k, o);
        });
        const lojas = [...porLoja.values()].map((o) => ({ ...o, saldo: round2(o.saldo), vencido: round2(o.vencido) }));

        // Status por título só conta título ainda em aberto.
        const contStatusTit = {};
        stTit.filter((s) => abertos.has(chaveTit(s.cliente_cod, s.cliente_loja, s.titulo_prefixo, s.titulo_num, s.titulo_parcela, s.titulo_tipo)))
          .forEach((s) => { const st = trim(s.status); contStatusTit[st] = (contStatusTit[st] || 0) + 1; });

        return {
          titulosAbertos: lojas.reduce((s, o) => s + o.qtd, 0),
          saldoAberto: round2(lojas.reduce((s, o) => s + o.saldo, 0)),
          titulosVencidos: lojas.reduce((s, o) => s + o.qtdVencido, 0),
          saldoVencido: round2(lojas.reduce((s, o) => s + o.vencido, 0)),
          maiorAtraso: lojas.reduce((m, o) => Math.max(m, o.maiorAtraso), 0),
          lojas,
          statusCliente: stCli.filter(daLoja).map((s) => ({
            cod: trim(s.cliente_cod), loja: trim(s.cliente_loja), status: trim(s.status),
            label: STATUS_LABEL[trim(s.status)] || trim(s.status), observacao: s.observacao || '',
            em: s.dt_atualizacao, por: trim(s.user_nome)
          })),
          statusTitulos: Object.entries(contStatusTit).map(([status, qtd]) => ({ status, label: STATUS_LABEL[status] || status, qtd }))
            .sort((a, b) => b.qtd - a.qtd),
          ultimasAcoes: acoes.filter(daLoja).map((a) => ({
            cod: trim(a.cliente_cod), loja: trim(a.cliente_loja), tipoAcao: trim(a.tipo_acao), resultado: trim(a.resultado),
            descricao: trim(a.descricao).slice(0, 300), em: a.criado_em, por: trim(a.user_nome)
          }))
        };
      })().catch((e) => { console.error('credito-cruzamento cobranca:', e.message); erros.cobranca = 'Falha ao carregar a cobrança.'; return null; });

      const principal = (codIn && lojaIn && pares.find((c) => c.cod === codIn && c.loja === lojaIn)) || pares[0] || null;
      const tarefa360 = (async () => {
        if (!quer('credito360') || !doCredito || !principal || erros.protheus) return null;
        return CreditoAnalise.resumo({ Pg, Protheus }, principal.cod, principal.loja);
      })().catch((e) => { console.error('credito-cruzamento 360:', e.message); erros.credito360 = 'Falha ao calcular o Crédito 360.'; return null; });

      const [cobranca, credito360] = await Promise.all([tarefaCobranca, tarefa360]);

      // Parecer e motivos são do crédito: quem vem da Cobrança vê só resultado e condições.
      const limpar = (a) => (doCredito ? a : { ...a, parecer: '', motivos: [] });

      return res.json({
        documento: doc || null, tipoDocumento: doc ? CR.tipoDocumento(doc) : null,
        janelaDias: CR.JANELA_DUPLICIDADE_DIAS,
        clientes,
        analises: analises.map(limpar),
        mesmaRaiz: mesmaRaiz.map(limpar),
        resumoAnalises: {
          total: analises.length, recentes: recentes.length,
          aprovadas: analises.filter((a) => CR.ehAprovacao(a.resultado)).length,
          reprovadas: analises.filter((a) => a.resultado === 'Reprovado').length,
          ultima: ultima ? { grupoId: ultima.grupoId, resultado: ultima.resultado, criadoEm: ultima.criadoEm, analistaNome: ultima.analistaNome } : null
        },
        alerta,
        condicoesVigentes,
        cobranca,
        credito360: credito360 ? { ...credito360, principal: principal ? `${principal.cod}/${principal.loja}` : null } : null,
        acesso: { credito360: tem(15100), cobranca: tem(9001), parecer: doCredito },
        erros
      });
    } catch (err) {
      console.error('financeiro/credito-cruzamento:', err);
      return res.status(500).json({ message: 'Erro ao cruzar informações: ' + err.message });
    }
  }
});

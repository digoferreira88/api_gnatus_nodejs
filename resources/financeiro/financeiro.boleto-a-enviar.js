// GET /financeiro/boleto-a-enviar — boletos REGISTRADOS no banco, prontos pra
// disparar ao cliente (linha digitável por e-mail/WhatsApp).
//
// Fonte: tab_boleto_envio_lote_retorno (status_banco='REGISTRADO') — ou seja,
// títulos que passaram pelo fluxo de lote da Intranet e o banco já confirmou o
// registro (após "Atualizar banco"). Enriquecido com valor/vencimento (do
// lote_titulo) e contato do cliente (SA1 do Protheus: telefone/e-mail).
//
// Query:
//   ?pendentes=1            só os ainda não disparados
//   ?busca=                  cliente / NF / cod cliente
//   ?dataDisparoIni=YYYY-MM-DD  filtra r.disparado_em >= ini
//   ?dataDisparoFim=YYYY-MM-DD  filtra r.disparado_em < (fim + 1 dia)
//   ?bordero=                numero do lote_protheus (l.lote_protheus = ?)
//
// Quando dataDisparoIni/Fim ou bordero estão setados, "pendentes" é IGNORADO —
// nao faz sentido cruzar "so nao disparados" com "filtrar por data de disparo".
// Permissão 8005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);
// YYYY-MM-DD valida (ou vazio). Bloqueia injecao de SQL no Date filter.
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(trim(v));

module.exports = (app) => ({
  verb: 'get',
  route: '/boleto-a-enviar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const busca = trim(req.query.busca).toUpperCase();
    const dataDisparoIni = isYmd(req.query.dataDisparoIni) ? trim(req.query.dataDisparoIni) : '';
    const dataDisparoFim = isYmd(req.query.dataDisparoFim) ? trim(req.query.dataDisparoFim) : '';
    const bordero = trim(req.query.bordero);
    // "pendentes=1" e os filtros de disparo/bordero sao mutuamente exclusivos
    const temFiltroDisparo = !!(dataDisparoIni || dataDisparoFim || bordero);
    const soPendentes = !temFiltroDisparo && String(req.query.pendentes || '') === '1';

    const conds = [`r.status_banco = 'REGISTRADO'`];
    const params = {};
    if (soPendentes) conds.push(`r.disparado_em IS NULL`);
    if (busca) {
      conds.push(`(UPPER(t.cliente_nome) LIKE '%' || @q || '%' OR r.numero LIKE '%' || @q || '%' OR r.cliente_cod = @q)`);
      params.q = busca;
    }
    if (dataDisparoIni) {
      conds.push(`r.disparado_em >= @dispIni::timestamp`);
      params.dispIni = dataDisparoIni;
    }
    if (dataDisparoFim) {
      // Fim exclusivo do dia seguinte: usa < (fim+1 dia) pra incluir 23:59:59
      conds.push(`r.disparado_em < (@dispFim::date + INTERVAL '1 day')`);
      params.dispFim = dataDisparoFim;
    }
    if (bordero) {
      // Borderô vem do retorno (E1_NUMBOR, gravado no adotar-retorno/se1) com
      // fallback pro lote_protheus (borderô gerado pela intranet via Diego).
      conds.push(`COALESCE(NULLIF(TRIM(r.bordero_protheus), ''), TRIM(COALESCE(l.lote_protheus, ''))) = @bordero`);
      params.bordero = bordero;
    }

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT r.id, r.id_lote, r.prefixo, r.numero, r.parcela,
               r.cliente_cod, r.cliente_loja, r.nosso_numero,
               r.status_banco, r.disparado_em, r.canais_disparo,
               t.cliente_nome, t.valor, t.saldo, t.vencimento, t.tipo,
               l.banco_cod, l.banco_nome, l.banco_agencia, l.banco_conta,
               COALESCE(NULLIF(TRIM(r.bordero_protheus), ''), TRIM(COALESCE(l.lote_protheus, ''))) AS bordero
          FROM tab_boleto_envio_lote_retorno r
          JOIN tab_boleto_envio_lote l ON l.id = r.id_lote
          -- COALESCE em prefixo/parcela porque o INSERT do sincronizar grava ''
          -- (string vazia via trim()) enquanto a tab_titulo pode ter NULL. Sem
          -- COALESCE o JOIN falha pros titulos sem parcela (descoberto 2026-05-28).
          LEFT JOIN tab_boleto_envio_lote_titulo t
            ON t.id_lote = r.id_lote
           AND COALESCE(t.prefixo, '') = COALESCE(r.prefixo, '')
           AND t.numero = r.numero
           AND COALESCE(t.parcela, '') = COALESCE(r.parcela, '')
           AND t.cliente_cod = r.cliente_cod AND t.cliente_loja = r.cliente_loja
         WHERE ${conds.join(' AND ')}
         ORDER BY (r.disparado_em IS NOT NULL), t.vencimento, r.numero`,
        params
      );

      // Enriquecer com contato do cliente (SA1 do Protheus)
      const contatoMap = new Map();
      const chaves = [...new Set(rows.map(r => `${trim(r.cliente_cod)}|${trim(r.cliente_loja)}`))].filter(Boolean);
      if (chaves.length) {
        const inK = chaves.map((_, i) => `(@c${i} ,@l${i})`).join(',');
        const p = {};
        chaves.forEach((k, i) => { const [c, l] = k.split('|'); p[`c${i}`] = c; p[`l${i}`] = l; });
        // Monta OR de pares (cod, loja)
        const ors = chaves.map((_, i) => `(sa1.A1_COD = @c${i} AND sa1.A1_LOJA = @l${i})`).join(' OR ');
        try {
          const sa1 = await Protheus.connectAndQuery(`
            SELECT RTRIM(sa1.A1_COD) cod, RTRIM(sa1.A1_LOJA) loja,
                   RTRIM(sa1.A1_EMAIL) email, RTRIM(sa1.A1_DDD) ddd, RTRIM(sa1.A1_TEL) tel
              FROM SA1010 sa1 WITH (NOLOCK)
             WHERE sa1.D_E_L_E_T_ <> '*' AND (${ors})`, p);
          sa1.forEach(s => contatoMap.set(`${trim(s.cod)}|${trim(s.loja)}`, {
            email: trim(s.email),
            telefone: `${trim(s.ddd)}${trim(s.tel)}`
          }));
        } catch (e) {
          console.warn('boleto-a-enviar: falha ao buscar contatos SA1 —', e.message);
        }
        void inK; // (mantido por clareza; usamos os ORs acima)
      }

      const boletos = rows.map(r => {
        const contato = contatoMap.get(`${trim(r.cliente_cod)}|${trim(r.cliente_loja)}`) || { email: '', telefone: '' };
        return {
          id: r.id,
          idLote: r.id_lote,
          prefixo: trim(r.prefixo), numero: trim(r.numero), parcela: trim(r.parcela), tipo: trim(r.tipo),
          clienteCod: trim(r.cliente_cod), clienteLoja: trim(r.cliente_loja), clienteNome: trim(r.cliente_nome),
          nossoNumero: trim(r.nosso_numero),
          banco: trim(r.banco_cod), bancoNome: trim(r.banco_nome),
          valor: N(r.valor), saldo: N(r.saldo), vencimento: trim(r.vencimento),
          email: contato.email, telefone: contato.telefone,
          disparadoEm: r.disparado_em, canaisDisparo: trim(r.canais_disparo),
          bordero: trim(r.bordero)
        };
      });

      return res.json({
        boletos,
        total: boletos.length,
        pendentes: boletos.filter(b => !b.disparadoEm).length,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('boleto-a-enviar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

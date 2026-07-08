// GET /recebimento/pendentes?busca=&especie=
// Recebimento de NF de Entrada — lista as PRÉ-NOTAS do Protheus (SF1 com
// F1_STATUS em branco = digitada, aguardando classificação) cruzadas com o
// estado da conferência na intranet (tab_receb_conferencia), + histórico
// recente (conferidas/divergentes/classificadas). Perm 4005.
//
// A qtd dos itens NÃO sai aqui (conferência cega) — só contagem de itens.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([4005]);
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/pendentes',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const busca = trim(req.query.busca).toUpperCase();
    const fEspecie = trim(req.query.especie).toUpperCase();

    try {
      // 1) Pré-notas na SF1 (status em branco) — últimos 60 dias de recebimento
      const corte = (() => { const d = new Date(); d.setDate(d.getDate() - 60);
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; })();
      let pre;
      try {
        pre = await Protheus.connectAndQuery(`
          SELECT RTRIM(f1.F1_DOC) doc, RTRIM(f1.F1_SERIE) serie,
                 RTRIM(f1.F1_FORNECE) fornece, RTRIM(f1.F1_LOJA) loja,
                 RTRIM(f1.F1_ESPECIE) especie, RTRIM(f1.F1_TIPO) tipo,
                 f1.F1_EMISSAO emissao, f1.F1_RECBMTO recbmto,
                 f1.F1_VALBRUT valorBruto, RTRIM(f1.F1_CHVNFE) chave,
                 RTRIM(COALESCE(sa2.A2_NREDUZ, sa2.A2_NOME, '')) fornecedorNome,
                 (SELECT COUNT(*) FROM SD1010 d1 WITH (NOLOCK)
                   WHERE d1.D_E_L_E_T_ <> '*' AND d1.D1_FILIAL = f1.F1_FILIAL
                     AND d1.D1_DOC = f1.F1_DOC AND d1.D1_SERIE = f1.F1_SERIE
                     AND d1.D1_FORNECE = f1.F1_FORNECE AND d1.D1_LOJA = f1.F1_LOJA) qtItens
            FROM SF1010 f1 WITH (NOLOCK)
            LEFT JOIN SA2010 sa2 WITH (NOLOCK)
              ON sa2.A2_COD = f1.F1_FORNECE AND sa2.A2_LOJA = f1.F1_LOJA AND sa2.D_E_L_E_T_ <> '*'
           WHERE f1.D_E_L_E_T_ <> '*' AND f1.F1_FILIAL = '01'
             AND RTRIM(ISNULL(f1.F1_STATUS, '')) = ''
             AND f1.F1_RECBMTO >= @corte
           ORDER BY f1.F1_RECBMTO DESC, f1.F1_DOC DESC`, { corte });
      } catch (err) {
        if (ehConexao(err)) return res.status(503).json({ message: MSG_INDISPONIVEL, conexao: true });
        throw err;
      }

      // 2) Estado da conferência na intranet (todas as recentes, p/ cruzar + histórico)
      const confs = await Pg.connectAndQuery(`
        SELECT c.id, c.doc, c.serie, c.fornece, c.loja, c.fornecedor_nome, c.especie,
               c.emissao, c.recbmto, c.valor_bruto, c.qt_itens, c.status, c.observacao,
               c.conferido_em, c.classificado_em,
               uc.nome AS conferido_por_nome, ux.nome AS classificado_por_nome
          FROM tab_receb_conferencia c
          LEFT JOIN tab_intranet_usr uc ON uc.id = c.conferido_por
          LEFT JOIN tab_intranet_usr ux ON ux.id = c.classificado_por
         WHERE c.atualizado_em >= NOW() - INTERVAL '90 days'
         ORDER BY c.atualizado_em DESC`, {});
      const confPorChave = new Map();
      confs.forEach(c => confPorChave.set(`${trim(c.doc)}|${trim(c.serie)}|${trim(c.fornece)}|${trim(c.loja)}`, c));

      // 3) Monta a lista de pré-notas com o estado intranet
      let notas = pre.map(r => {
        const key = `${trim(r.doc)}|${trim(r.serie)}|${trim(r.fornece)}|${trim(r.loja)}`;
        const conf = confPorChave.get(key);
        return {
          doc: trim(r.doc), serie: trim(r.serie),
          fornece: trim(r.fornece), loja: trim(r.loja),
          fornecedorNome: trim(r.fornecedorNome),
          especie: trim(r.especie), tipo: trim(r.tipo),
          emissao: trim(r.emissao), recbmto: trim(r.recbmto),
          valorBruto: N(r.valorBruto), qtItens: N(r.qtItens),
          chave: trim(r.chave),
          // AGUARDANDO (sem registro) | RASCUNHO | CONFERIDA | DIVERGENTE | CLASSIFICADA
          statusConferencia: conf ? trim(conf.status) : 'AGUARDANDO',
          idConferencia: conf ? conf.id : null,
          conferidoPor: conf ? trim(conf.conferido_por_nome) : null,
          conferidoEm: conf ? conf.conferido_em : null
        };
      });

      if (fEspecie) notas = notas.filter(n => n.especie === fEspecie);
      if (busca) {
        notas = notas.filter(n =>
          n.doc.includes(busca) || n.fornecedorNome.toUpperCase().includes(busca) || n.fornece === busca);
      }

      // 4) Histórico: conferências que não estão mais como pré-nota (finalizadas)
      const chavesPre = new Set(pre.map(r => `${trim(r.doc)}|${trim(r.serie)}|${trim(r.fornece)}|${trim(r.loja)}`));
      const historico = confs
        .filter(c => ['CONFERIDA', 'DIVERGENTE', 'CLASSIFICADA'].includes(trim(c.status)))
        .map(c => ({
          id: c.id, doc: trim(c.doc), serie: trim(c.serie),
          fornece: trim(c.fornece), loja: trim(c.loja),
          fornecedorNome: trim(c.fornecedor_nome), especie: trim(c.especie),
          emissao: trim(c.emissao), recbmto: trim(c.recbmto),
          valorBruto: N(c.valor_bruto), qtItens: N(c.qt_itens),
          status: trim(c.status), observacao: trim(c.observacao) || null,
          conferidoPor: trim(c.conferido_por_nome) || null, conferidoEm: c.conferido_em,
          classificadoPor: trim(c.classificado_por_nome) || null, classificadoEm: c.classificado_em,
          aindaPreNota: chavesPre.has(`${trim(c.doc)}|${trim(c.serie)}|${trim(c.fornece)}|${trim(c.loja)}`)
        }))
        .slice(0, 100);

      const kpis = {
        aguardando: notas.filter(n => n.statusConferencia === 'AGUARDANDO').length,
        rascunho: notas.filter(n => n.statusConferencia === 'RASCUNHO').length,
        conferidas: historico.filter(h => h.status === 'CONFERIDA').length,
        divergentes: historico.filter(h => h.status === 'DIVERGENTE').length,
        classificadas: historico.filter(h => h.status === 'CLASSIFICADA').length,
        totalPreNotas: notas.length
      };

      return res.json({ kpis, notas, historico, geradoEm: new Date().toISOString() });
    } catch (err) {
      console.error('recebimento/pendentes:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

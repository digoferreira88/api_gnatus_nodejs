// GET /ciosp/estande/meus?desde=<ISO> — o que mudou no servidor para o vendedor desde
// a última sincronização (spec §7.3): orçamentos (número, desconto aprovado/recusado),
// pedidos (devolvido pelo ADM, com o motivo) e, para o gerente, quantos pedidos de
// aprovação esperam por ele. Perm 19005.
//
// `agora` vem do RELÓGIO DO BANCO — o app guarda e manda de volta como `desde`, sem
// depender do relógio do celular.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19005, 0]);
const E = require('../../services/ciospEdicao');

module.exports = (app) => ({
  verb: 'get',
  route: '/estande/meus',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const user = req.user && req.user[0];
    const uid = Number(user?.ID ?? user?.id) || null;
    const desdeTxt = String(req.query.desde || '').trim();
    const desde = desdeTxt && !Number.isNaN(Date.parse(desdeTxt)) ? new Date(desdeTxt) : null;

    try {
      const cfg = await E.getConfig(app);
      if (!cfg.edicao || !cfg.ativa) return res.status(409).json({ message: 'Nenhuma edição do CIOSP está ativa.' });
      const ed = cfg.edicao;

      const [agora, orcamentos, pedidos, papel] = await Promise.all([
        E.q(app, `SELECT NOW() AS agora`),
        E.q(app,
          `SELECT uuid, numero, situacao, desconto_status, desconto_obs, desconto_solicitado_em, total, atualizado_em
             FROM tab_ciosp_orcamento
            WHERE edicao = $1 AND vendedor_id = $2 AND ($3::timestamptz IS NULL OR atualizado_em > $3)
            ORDER BY atualizado_em`, [ed, uid, desde]),
        E.q(app,
          `SELECT p.uuid, p.numero, p.situacao, p.devolvido_motivo, p.total, o.uuid AS orcamento_uuid, p.atualizado_em
             FROM tab_ciosp_pedido p LEFT JOIN tab_ciosp_orcamento o ON o.id = p.orcamento_id
            WHERE p.edicao = $1 AND p.vendedor_id = $2 AND ($3::timestamptz IS NULL OR p.atualizado_em > $3)
            ORDER BY p.atualizado_em`, [ed, uid, desde]),
        E.q(app, `SELECT papel FROM tab_ciosp_equipe WHERE edicao = $1 AND usuario_id = $2 AND ativo`, [ed, uid])
      ]);

      let aprovacoesPendentes = 0;
      if (papel[0] && papel[0].papel === 'gerente') {
        const c = await E.q(app,
          `SELECT COUNT(*)::int AS n
             FROM tab_ciosp_orcamento o
             JOIN tab_ciosp_equipe e ON e.edicao = o.edicao AND e.usuario_id = o.vendedor_id AND e.ativo
            WHERE o.edicao = $1 AND e.gerente_id = $2 AND o.desconto_status = 'pendente'
              AND o.desconto_solicitado_em IS NOT NULL AND o.situacao IN ('rascunho', 'enviado')`, [ed, uid]);
        aprovacoesPendentes = c[0].n;
      }

      return res.json({
        agora: agora[0].agora,
        edicao: ed,
        orcamentos: orcamentos.map(o => ({ ...o, total: Number(o.total) })),
        pedidos: pedidos.map(p => ({ ...p, total: Number(p.total) })),
        aprovacoes_pendentes: aprovacoesPendentes
      });
    } catch (err) {
      console.error('ciosp/estande-meus:', err.message);
      return res.status(500).json({ message: 'Erro ao buscar as novidades: ' + err.message });
    }
  }
});

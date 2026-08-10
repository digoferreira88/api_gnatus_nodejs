// GET /controladoria/vendas/snapshots — lista os snapshots (meses de entrega) já
// carregados na base + estatística de cada um + o último import. Perm 11006.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11006, 0]);

module.exports = (app) => ({
  verb: 'get',
  route: '/vendas/snapshots',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const snaps = await Pg.connectAndQuery(`
        SELECT snapshot_mes,
               COUNT(*)               linhas,
               COUNT(DISTINCT pedido) pedidos,
               COALESCE(SUM(total_item), 0) total_item,
               MIN(ano) ano_min, MAX(ano) ano_max,
               MAX(criado_em) criado_em
          FROM tab_ctrl_vendas_snapshot
         GROUP BY snapshot_mes ORDER BY snapshot_mes DESC`, {});

      const imports = await Pg.connectAndQuery(`
        SELECT id, snapshot_mes, arquivo, linhas, status, erro, iniciado_em, concluido_em
          FROM tab_ctrl_vendas_import
         ORDER BY iniciado_em DESC LIMIT 20`, {});

      return res.json({ snapshots: snaps, imports });
    } catch (err) {
      console.error('controladoria/vendas-snapshots:', err);
      return res.status(500).json({ message: 'Erro ao listar os snapshots.' });
    }
  }
});

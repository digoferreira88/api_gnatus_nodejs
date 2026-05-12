// GET /controladoria/estoque-parametros
// Lista o registro global + 1 por tipo de produto.
// Permissao 11004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11004]);
const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/estoque-parametros',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const rows = await Pg.connectAndQuery(`
        SELECT tipo_produto, lead_time_dias, nivel_servico, janela_demanda_meses, atualizado_em
          FROM tab_estoque_parametros
         ORDER BY tipo_produto NULLS FIRST`,
        {}
      );
      return res.json({
        parametros: rows.map(r => ({
          tipo_produto: trim(r.tipo_produto) || null,
          lead_time_dias: N(r.lead_time_dias),
          nivel_servico: N(r.nivel_servico),
          janela_demanda_meses: N(r.janela_demanda_meses),
          atualizado_em: r.atualizado_em
        }))
      });
    } catch (err) {
      console.error('estoque-parametros GET:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

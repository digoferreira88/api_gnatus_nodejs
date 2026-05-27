// GET /gerencia/cc-orcamento?ano=YYYY
// Lista os orcamentos cadastrados em tab_centro_custo_orcamento.
// Usado pela tela de configuracao da aba "Centro de Custo" do DRE.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10001]);

module.exports = (app) => ({
  verb: 'get',
  route: '/cc-orcamento',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const ano = parseInt(req.query.ano, 10);
    if (!ano || ano < 2000 || ano > 2100) {
      return res.status(400).json({ message: 'Parametro ano (YYYY) obrigatorio.' });
    }

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT o.id, o.cc_codigo, o.cc_descricao, o.ano, o.valor_orcado, o.obs,
               o.criado_por, uc.nome AS criado_por_nome,
               o.atualizado_por, ua.nome AS atualizado_por_nome,
               o.criado_em, o.atualizado_em
          FROM tab_centro_custo_orcamento o
          LEFT JOIN tab_intranet_usr uc ON uc.id = o.criado_por
          LEFT JOIN tab_intranet_usr ua ON ua.id = o.atualizado_por
         WHERE o.ano = @ano
         ORDER BY o.cc_codigo`, { ano });

      return res.json({
        ano,
        total: rows.length,
        valorTotalOrcado: rows.reduce((s, r) => s + Number(r.valor_orcado || 0), 0),
        orcamentos: rows
      });
    } catch (err) {
      console.error('cc-orcamento-listar:', err);
      return res.status(500).json({ message: 'Erro ao listar orcamentos.' });
    }
  }
});

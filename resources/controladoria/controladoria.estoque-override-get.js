// GET /controladoria/estoque-produto-override/:cod
// Retorna parametros manuais (e fallbacks B1) de 1 produto. Permissao 11004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11004]);

module.exports = (app) => ({
  verb: 'get',
  route: '/estoque-produto-override/:cod',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const cod = String(req.params.cod || '').trim();
    if (!cod) return res.status(400).json({ message: 'codigo obrigatorio.' });

    const rows = await Pg.connectAndQuery(`
      SELECT m.cod_produto, m.tipo_produto, m.descricao, m.unidade,
             m.lead_time_dias        AS lead_time_b1,
             m.lead_time_override,
             m.demanda_mensal_manual,
             m.estoque_seguranca_manual,
             m.observacao_manual,
             m.manual_em,
             u.nome AS atualizado_por_nome
        FROM tab_estoque_produto_meta m
        LEFT JOIN tab_intranet_usr u ON u.id = m.atualizado_por
       WHERE m.cod_produto = @cod`,
      { cod }
    );
    if (!rows.length) {
      return res.status(404).json({
        message: 'Produto nao encontrado no cache. Rode o snapshot primeiro.'
      });
    }
    return res.json(rows[0]);
  }
});

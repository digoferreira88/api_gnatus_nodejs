// GET /controladoria/estoque-produto-override?busca=XXX
// Lista produtos com parametros manuais cadastrados.
// Permissao 11004 (Estoque - Controladoria).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11004]);

module.exports = (app) => ({
  verb: 'get',
  route: '/estoque-produto-override',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const busca = String(req.query.busca || '').trim().toUpperCase();
    try {
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
         WHERE (m.lead_time_override IS NOT NULL
                OR m.demanda_mensal_manual IS NOT NULL
                OR m.estoque_seguranca_manual IS NOT NULL)
           ${busca ? `AND (UPPER(m.cod_produto) LIKE '%' || @b || '%' OR UPPER(m.descricao) LIKE '%' || @b || '%')` : ''}
         ORDER BY m.cod_produto`,
        busca ? { b: busca } : {}
      );
      return res.json({ total: rows.length, produtos: rows });
    } catch (err) {
      console.error('estoque-override-list:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

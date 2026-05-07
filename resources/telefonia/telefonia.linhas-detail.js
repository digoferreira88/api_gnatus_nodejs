// GET /telefonia/linhas/:id — detalhe de 1 linha + historico completo.
// Permissao 1027.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1027]);

module.exports = (app) => ({
  verb: 'get',
  route: '/linhas/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'id invalido.' });
    }

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT l.*, o.nome AS operadora,
               c.numero_conta, c.numero_cliente, c.razao_social,
               d.nome AS departamento
          FROM tab_telefonia_linha l
          JOIN tab_operadora o ON o.id = l.id_operadora
          LEFT JOIN tab_telefonia_conta c        ON c.id = l.id_conta
          LEFT JOIN tab_telefonia_departamento d ON d.id = l.id_departamento
         WHERE l.id = @id`, { id });

      if (!rows.length) return res.status(404).json({ message: 'Linha nao encontrada.' });

      const hist = await Pg.connectAndQuery(`
        SELECT id, acao, antes, depois, id_usuario, usuario_nome, descricao, criado_em
          FROM tab_telefonia_linha_hist
         WHERE id_linha = @id
         ORDER BY criado_em DESC, id DESC
         LIMIT 200`, { id });

      return res.json({ linha: rows[0], historico: hist });
    } catch (err) {
      console.error('telefonia/linhas detail:', err);
      return res.status(500).json({ message: 'Erro ao buscar linha: ' + err.message });
    }
  }
});

const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'post',
  route: '/items/:id/delete',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ message: 'ID inválido.' });

    try {
      // Snapshot antes de deletar (so titulo/categoria/url — nada criptografado)
      const before = await Pg.connectAndQuery(
        `SELECT titulo, categoria, url FROM tab_cofre_item WHERE id = @id AND id_user = @idUser`,
        { id, idUser: user.ID }
      );
      await Pg.connectAndQuery(
        `DELETE FROM tab_cofre_item WHERE ID = @id AND ID_USER = @idUser`,
        { id, idUser: user.ID }
      );
      Auditoria.registrar(app, {
        modulo: 'Cofre', submodulo: 'Item', acao: 'DELETE', severidade: 'AVISO',
        req, entidade: 'cofre_item', entidadeId: id,
        descricao: `Removeu item do Cofre: "${before[0]?.titulo || '(desconhecido)'}"`,
        antes: before[0] || null
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro cofre/items-delete:', err);
      return res.status(500).json({ message: 'Erro ao excluir item.' });
    }
  }
});

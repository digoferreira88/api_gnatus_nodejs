const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'post',
  route: '/items',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const { titulo, categoria, url, usuarioEnc, senhaEnc, notasEnc } = req.body || {};
    if (!titulo || !senhaEnc) {
      return res.status(400).json({ message: 'Título e senha são obrigatórios.' });
    }

    try {
      const result = await Pg.connectAndQuery(
        `INSERT INTO tab_cofre_item (id_user, titulo, categoria, url, usuario_enc, senha_enc, notas_enc)
         VALUES (@id, @titulo, @categoria, @url, @usuarioEnc, @senhaEnc, @notasEnc)
         RETURNING id`,
        {
          id: user.ID,
          titulo,
          categoria: categoria || '',
          url: url || '',
          usuarioEnc: usuarioEnc || '',
          senhaEnc,
          notasEnc: notasEnc || ''
        }
      );
      Auditoria.registrar(app, {
        modulo: 'Cofre', submodulo: 'Item', acao: 'CREATE', severidade: 'INFO',
        req, entidade: 'cofre_item', entidadeId: result[0]?.id,
        descricao: `Criou item no Cofre: "${titulo}"${categoria ? ' (' + categoria + ')' : ''}`,
        meta: { titulo, categoria, url }   // sem incluir as cifras
      });
      return res.status(201).json({ ok: true, id: result[0]?.id });
    } catch (err) {
      console.error('Erro cofre/items-create:', err);
      return res.status(500).json({ message: 'Erro ao criar item.' });
    }
  }
});

// Adiciona comentário interno (visível apenas para equipe) em um cliente
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002]);

module.exports = (app) => ({
  verb: 'post',
  route: '/comentario',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const { clienteCod, clienteLoja, texto } = req.body || {};
    if (!clienteCod || !clienteLoja) return res.status(400).json({ message: 'Cliente é obrigatório.' });
    if (!texto || !String(texto).trim()) return res.status(400).json({ message: 'Texto do comentário é obrigatório.' });

    try {
      const result = await Pg.connectAndQuery(
        `INSERT INTO tab_cobranca_comentario (cliente_cod, cliente_loja, id_user, texto)
         VALUES (@cod, @loja, @uid, @texto)
         RETURNING id, criado_em`,
        {
          cod: String(clienteCod).trim(),
          loja: String(clienteLoja).trim(),
          uid: user.ID,
          texto: String(texto).trim()
        }
      );
      return res.status(201).json({
        ok: true,
        id: result[0]?.id,
        criadoEm: result[0]?.criado_em,
        userNome: user.NOME
      });
    } catch (err) {
      console.error('Erro cobranca/comentario-create:', err);
      return res.status(500).json({ message: 'Erro ao adicionar comentário.' });
    }
  }
});

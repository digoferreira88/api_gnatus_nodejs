// Cria uma nova permissão
module.exports = app => ({
  verb: 'post',
  route: '/add/permissao',
  middlewares: [require('../../middlewares/requirePerm')(app)([1026])],  // 1026 = Gerenciamento Permissoes

  handler: async (req, res) => {
    const { Pg } = app.services;
    const { ID_PERMISSAO, NOME, MODULO } = req.body || {};

    if (!ID_PERMISSAO || !NOME || !MODULO) {
      return res.status(400).json({ message: 'ID_PERMISSAO, NOME e MODULO são obrigatórios.' });
    }

    try {
      const result = await Pg.connectAndQuery(
        `INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
         VALUES (@idPerm, @nome, @modulo)
         ON CONFLICT (id_permissao) DO NOTHING
         RETURNING id`,
        { idPerm: Number(ID_PERMISSAO), nome: String(NOME), modulo: String(MODULO) }
      );
      const id = result[0]?.id || null;
      if (!id) {
        return res.status(409).json({ message: `Permissão ${ID_PERMISSAO} já existe.` });
      }
      return res.status(201).json({ message: 'Permissão criada com sucesso!', id });
    } catch (error) {
      console.error('Erro criar permissão:', error);
      return res.status(500).json({ message: error.message });
    }
  }
});

// GET /financeiro/boleto-lote/:id — cabecalho + titulos do lote
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);

module.exports = (app) => ({
  verb: 'get',
  route: '/boleto-lote/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });

    try {
      const cab = await Pg.connectAndQuery(
        `SELECT * FROM tab_boleto_envio_lote WHERE id = @id`, { id }
      );
      if (!cab.length) return res.status(404).json({ message: 'Lote nao encontrado.' });

      const isAdmin = await Pg.connectAndQuery(
        `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @uid AND id_permissao = 0 LIMIT 1`,
        { uid: user.ID }
      );
      if (cab[0].id_user !== user.ID && !isAdmin.length) {
        return res.status(403).json({ message: 'Sem permissao.' });
      }

      const titulos = await Pg.connectAndQuery(
        `SELECT * FROM tab_boleto_envio_lote_titulo WHERE id_lote = @id
          ORDER BY vencimento ASC, cliente_nome`, { id }
      );

      // Retornos do banco (Onda 3): status sincronizado por titulo
      let retornos = [];
      try {
        retornos = await Pg.connectAndQuery(
          `SELECT * FROM tab_boleto_envio_lote_retorno WHERE id_lote = @id`, { id }
        );
      } catch (e) {
        // Tabela pode nao existir se migration 44 nao foi rodada — tolerante
        if (!String(e.message).includes('does not exist')) throw e;
      }

      return res.json({ lote: cab[0], titulos, retornos });
    } catch (err) {
      console.error('boleto-lote-detail:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

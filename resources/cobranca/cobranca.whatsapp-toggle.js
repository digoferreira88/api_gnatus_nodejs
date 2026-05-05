// POST /cobranca/whatsapp-toggle — liga/desliga a automacao.
// Body: { ativa: true|false }
// Permissao 1030.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1030]);

module.exports = (app) => ({
  verb: 'post',
  route: '/whatsapp-toggle',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const ativa = req.body?.ativa === true;
    const valor = ativa ? 'true' : 'false';

    try {
      await Pg.connectAndQuery(`
        UPDATE tab_cobranca_whatsapp_config
           SET valor = @valor, atualizado_por = @uid, atualizado_em = NOW()
         WHERE chave = 'automacao_ativa'`,
        { valor, uid: user.ID }
      );
      return res.json({ ok: true, automacao_ativa: ativa });
    } catch (err) {
      console.error('whatsapp-toggle:', err);
      return res.status(500).json({ message: 'Erro ao alterar status.' });
    }
  }
});

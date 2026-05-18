// GET /users/all — lista usuarios. Perm 1028 (Gestao Usuarios).
//
// IMPORTANTE: SELECT enumerado para nao vazar SENHA (bcrypt) nem blobs do
// cofre (cofre_salt, cofre_verifier, cofre_mk_enc_pass, cofre_mk_enc_recovery).
// Vazamento desses campos permite ataque offline na master password.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1028]);

module.exports = app => ({
  verb: 'get',
  route: '/all',
  middlewares: [requirePerm(app)],
  handler: async (req, res) => {
    const { Pg } = app.services;
    const data = await Pg.connectAndQuery(`
      SELECT id, nome, email, matricula, ativo, codigo_protheus, ramal,
             (cofre_verifier IS NOT NULL) AS cofre_ativo
        FROM tab_intranet_usr
       ORDER BY ativo DESC, nome
    `);
    return res.json(data);
  }
});

// requirePerm(perms[]) — middleware reutilizavel pra checar permissoes do usuario logado.
//
// Uso (em qualquer resource):
//   const requirePerm = require('../../middlewares/requirePerm')(app);
//   module.exports = (app) => ({
//     verb: 'post', route: '/algo',
//     middlewares: [requirePerm([1026])],   // perm 0 (admin universal) sempre passa
//     handler: async (req, res) => { ... }
//   });
//
// Tambem aceita custom check via funcao (ex: dono do recurso ou admin):
//   middlewares: [requirePerm([1026], { allowSelf: 'id' })]
//   -> permite se req.user[0].ID === Number(req.params.id) OU se tem perm

module.exports = (app) => {
  return function requirePerm(perms, opts = {}) {
    const lista = Array.isArray(perms) ? perms : [perms];
    const allowSelf = opts.allowSelf || null;   // nome do param de id (ex: 'id') que se igual ao user.ID libera

    return async (req, res, next) => {
      const user = req.user && req.user[0];
      if (!user) return res.status(401).json({ message: 'Nao autenticado.' });

      // Auto-permitido se eh o proprio usuario operando sobre si
      if (allowSelf && req.params && req.params[allowSelf] != null) {
        const targetId = Number(req.params[allowSelf]);
        if (Number.isInteger(targetId) && targetId === Number(user.ID)) return next();
      }

      try {
        const placeholders = lista.map((_, i) => `@p${i}`).join(',');
        const params = { id: user.ID };
        lista.forEach((p, i) => { params[`p${i}`] = p; });
        const r = await app.services.Pg.connectAndQuery(
          `SELECT 1 FROM tab_intranet_usr_permissoes
            WHERE id_user = @id AND id_permissao IN (0, ${placeholders}) LIMIT 1`,
          params
        );
        if (r.length) return next();
        return res.status(403).json({ message: 'Sem permissao.' });
      } catch (err) {
        console.error('requirePerm err:', err.message);
        return res.status(500).json({ message: 'Erro ao validar permissao.' });
      }
    };
  };
};

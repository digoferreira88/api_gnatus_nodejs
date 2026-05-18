// Middleware de autenticacao JWT.
//
// JWT vem APENAS via header Authorization: Bearer <token>.
// Aceitar via querystring (?token=) vazava o token em logs do Nginx, Referer
// headers e historico do browser. Pra abrir PDFs em nova aba, gere URL de
// curto prazo no backend em vez de embutir o JWT na URL.
//
// SELECT enumerado: nao traz SENHA (bcrypt) nem blobs do cofre. Antes era
// SELECT *, expondo esses dados em req.user[0] e correndo risco de vazar se
// algum endpoint imprudente fizer res.json({ user: req.user[0] }).

module.exports = (app) => {
  let { Jwt, Mysql, Pg } = app.services;

  return async (req, res, next) => {
    try {
      let token = null;
      if (req.headers.authorization && req.headers.authorization.split(' ')[0].toLowerCase() === 'bearer') {
        token = req.headers.authorization.split(' ')[1];
      }
      if (!token) return res.status(401).send('Invalid token');

      var decoded = Jwt.verify(token);
      if (!decoded?.id) return res.status(401).send('Invalid token');

      // Busca o usuario conforme tipo do token. SELECT enumerado pra nao
      // trazer SENHA/cofre_* desnecessariamente.
      if (decoded.type === 'usuario') {
        req.user = await Pg.connectAndQuery(
          `SELECT id, nome, email, matricula, ativo, codigo_protheus, ramal
             FROM tab_intranet_usr WHERE id = @id AND ativo = true`,
          { id: decoded.id }
        );
      } else if (decoded.type === 'motorista') {
        req.user = await Mysql.queryOne(
          'select * from TAB_MOTORISTA where id = ? and ativo = 1',
          [decoded.id]
        );
      } else if (decoded.type === 'eco_camarote') {
        req.user = await Mysql.queryOne(
          'select * from TAB_ECO_CAMAROTE_LOGIN_USR WHERE id = ? and ativo = 1',
          [decoded.id]
        );
      } else if (decoded.type === 'franqueado') {
        req.user = await Pg.connectAndQuery(
          `SELECT * FROM tab_intranet_usr_franqueado WHERE id = @id AND ativo = true`,
          { id: decoded.id }
        );
      } else {
        return res.status(401).send('Invalid token');
      }

      if (!req.user || (Array.isArray(req.user) && req.user.length === 0)) {
        return res.status(401).send('Invalid token');
      }

      next();
    } catch (err) {
      console.error('Error verifying token:', err.message);
      return res.status(401).send('Invalid token');
    }
  };
};

const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

// Rate limit: 5 tentativas por IP a cada 15 min. Mais que suficiente pra uso
// legitimo (humano) e bloqueia brute force.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Muitas tentativas. Tente novamente em 15 minutos.' }
});

module.exports = (app) => ({
  verb: "post",
  route: "/login",
  anonymous: true,
  middlewares: [loginLimiter],

  handler: async (req, res) => {
    const { Pg, Jwt } = app.services;

    const { email, senha } = req.body || {};
    if (!email || !senha) {
      // Mensagem unica pra nao revelar se email existe
      return res.status(401).json({ message: 'E-mail ou senha invalidos.' });
    }

    try {
      const user = await getUserByEmail(Pg, email);

      // Mesma mensagem em ambos os casos pra evitar user enumeration
      if (!user) {
        // Custo constante: faz hash dummy pra nao vazar timing-side-channel
        bcrypt.compareSync(senha, '$2a$10$abcdefghijklmnopqrstuv.WXYZ0123456789abcdef');
        return res.status(401).json({ message: 'E-mail ou senha invalidos.' });
      }

      const ok = bcrypt.compareSync(senha, user.SENHA);
      if (!ok) return res.status(401).json({ message: 'E-mail ou senha invalidos.' });

      const token = Jwt.generate({ id: user.ID, type: 'usuario' });
      return res.json({ token });
    } catch (error) {
      console.error("Erro ao realizar a autenticacao:", error.message);
      return res.status(500).json({ message: "Erro interno ao autenticar." });
    }
  },
});

async function getUserByEmail(Pg, email) {
  const query = `
    SELECT ID, NOME, EMAIL, SENHA, ATIVO
      FROM tab_intranet_usr
     WHERE EMAIL = @email AND ativo = true`;
  const [user] = await Pg.connectAndQuery(query, { email });
  return user;
}

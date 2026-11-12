const bcrypt = require('bcryptjs');
const Auditoria = require('../../services/auditoria');
// Limitador compartilhado: 20 tentativas ERRADAS por IP a cada 15 min; login certo
// não conta. O antigo (5 por IP, contando os certos) travaria uma sala de
// treinamento ou o estande do CIOSP, onde todos saem pelo mesmo IP.
const { loginLimiter } = require('../../middlewares/rateLimit');

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
        Auditoria.registrar(app, {
          modulo: 'Sistema', submodulo: 'Login', acao: 'LOGIN_FAIL', severidade: 'AVISO',
          req, usuarioEmail: email,
          descricao: `Tentativa de login com e-mail nao cadastrado: ${email}`
        });
        return res.status(401).json({ message: 'E-mail ou senha invalidos.' });
      }

      const ok = bcrypt.compareSync(senha, user.SENHA);
      if (!ok) {
        Auditoria.registrar(app, {
          modulo: 'Sistema', submodulo: 'Login', acao: 'LOGIN_FAIL', severidade: 'ALERTA',
          req, idUsuario: user.ID, usuarioEmail: user.EMAIL, usuarioNome: user.NOME,
          descricao: `Senha incorreta no login`
        });
        return res.status(401).json({ message: 'E-mail ou senha invalidos.' });
      }

      const token = Jwt.generate({ id: user.ID, type: 'usuario' });
      Auditoria.registrar(app, {
        modulo: 'Sistema', submodulo: 'Login', acao: 'LOGIN', severidade: 'INFO',
        req, idUsuario: user.ID, usuarioEmail: user.EMAIL, usuarioNome: user.NOME,
        descricao: `Login efetuado com sucesso`
      });
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

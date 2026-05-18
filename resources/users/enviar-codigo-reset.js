// POST /users/enviar-codigo-reset
// Hardening:
//   - Resposta IDENTICA pra email existente/inexistente (anti-enumeration)
//   - Rate limit 5/hora/IP via middleware (anti brute-force)
//   - Codigo expira em 15min, removido apos uso

const { sendVerificationEmail } = require('../../services/emailService');
const { generateVerificationCode } = require('../../services/verificationService');
const { resetSenhaLimiter } = require('../../middlewares/rateLimit');

// Resposta canonica — sempre identica, independente de existir o email ou nao
const RESP_OK = { message: 'Se o e-mail estiver cadastrado, voce recebera um codigo em instantes.' };

module.exports = (app) => ({
  verb: 'post',
  route: '/enviar-codigo-reset',
  anonymous: true,
  middlewares: [resetSenhaLimiter],
  handler: async (req, res) => {
    const { Pg } = app.services;
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      // Valida formato. Mas mantemos resposta canonica pra nao indicar erro especifico.
      return res.json(RESP_OK);
    }

    try {
      const userResult = await Pg.connectAndQuery(
        `SELECT id FROM tab_intranet_usr WHERE LOWER(email) = @email AND ativo = true`,
        { email }
      );

      // Mesmo se nao encontrar, retorna OK — anti enumeration.
      if (userResult.length === 0) {
        // Pequeno delay constante pra evitar timing attack
        await new Promise(r => setTimeout(r, 80));
        return res.json(RESP_OK);
      }

      const codigo = generateVerificationCode();
      const expireDate = new Date(Date.now() + 15 * 60 * 1000);

      await Pg.connectAndQuery(`DELETE FROM tab_verificacao_intranet WHERE email = @email`, { email });
      await Pg.connectAndQuery(
        `INSERT INTO tab_verificacao_intranet (email, codigo, data_expiracao)
         VALUES (@email, @codigo, @dataExpiracao)`,
        { email, codigo, dataExpiracao: expireDate }
      );
      await sendVerificationEmail(email, codigo);
      return res.json(RESP_OK);
    } catch (error) {
      console.error('Erro ao enviar codigo de reset:', error.message);
      // Mesmo em erro, resposta generica pra nao vazar estado
      return res.json(RESP_OK);
    }
  }
});

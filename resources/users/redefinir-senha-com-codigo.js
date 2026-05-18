// POST /users/redefinir-senha-com-codigo
// Hardening:
//   - Rate limit (mesmo do envio: 5/hora/IP)
//   - Senha minima 10 chars com letra + numero
//   - Codigo apagado APOS qualquer tentativa de uso (evita brute force ilimitado por codigo)
//   - Resposta generica em caso de codigo invalido/expirado

const bcrypt = require('bcryptjs');
const { resetSenhaLimiter } = require('../../middlewares/rateLimit');

const SENHA_MIN = 10;
const ehSenhaForte = (s) => {
  if (typeof s !== 'string' || s.length < SENHA_MIN) return false;
  // Pelo menos 1 letra e 1 numero
  return /[A-Za-z]/.test(s) && /\d/.test(s);
};

module.exports = (app) => ({
  verb: 'post',
  route: '/redefinir-senha-com-codigo',
  anonymous: true,
  middlewares: [resetSenhaLimiter],
  handler: async (req, res) => {
    const { Pg } = app.services;
    const email = String(req.body?.email || '').trim().toLowerCase();
    const codigo = String(req.body?.codigo || '').trim();
    const novaSenha = String(req.body?.novaSenha || '');

    if (!email || !codigo || !novaSenha) {
      return res.status(400).json({ message: 'Todos os campos sao obrigatorios.' });
    }
    if (!ehSenhaForte(novaSenha)) {
      return res.status(400).json({
        message: `Senha fraca: minimo ${SENHA_MIN} caracteres com letras e numeros.`
      });
    }

    try {
      const codeResult = await Pg.connectAndQuery(
        `SELECT codigo, data_expiracao FROM tab_verificacao_intranet WHERE LOWER(email) = @email`,
        { email }
      );

      const valido = codeResult.length > 0
        && codeResult[0].codigo === codigo
        && new Date() <= new Date(codeResult[0].data_expiracao);

      // Sempre apaga o codigo apos tentativa, valido ou nao. Bloqueia brute
      // force de codigo: cada chute consome o codigo, atacante precisa pedir
      // outro via endpoint rate-limitado.
      await Pg.connectAndQuery(
        `DELETE FROM tab_verificacao_intranet WHERE LOWER(email) = @email`,
        { email }
      );

      if (!valido) {
        return res.status(400).json({ message: 'Codigo invalido ou expirado. Solicite um novo.' });
      }

      const senhaHash = bcrypt.hashSync(novaSenha, 10);
      await Pg.connectAndQuery(
        `UPDATE tab_intranet_usr SET senha = @senha WHERE LOWER(email) = @email AND ativo = true`,
        { senha: senhaHash, email }
      );

      return res.json({ message: 'Senha atualizada com sucesso.' });
    } catch (error) {
      console.error('Erro ao redefinir senha:', error.message);
      return res.status(500).json({ message: 'Erro ao atualizar senha.' });
    }
  }
});

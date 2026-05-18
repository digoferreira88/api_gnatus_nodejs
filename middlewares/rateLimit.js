// Rate limiters compartilhados (express-rate-limit).
//
// Uso em qualquer resource:
//   const { resetSenhaLimiter } = require('../../middlewares/rateLimit');
//   middlewares: [resetSenhaLimiter, ...]
//
// trust proxy: 1 ja esta setado no index.js (nginx na frente), entao req.ip
// vem do header X-Forwarded-For corretamente.

const rateLimit = require('express-rate-limit');

// Reset/envio de codigo: 5 por hora por IP. Brute-force em codigo de 6 digitos
// numericos exigiria 200k tentativas — esse limite cobre.
const resetSenhaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,        // 1h
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Muitas tentativas. Tente novamente daqui a 1 hora.' }
});

// Login: 20 por 15min por IP — protege contra brute force de senha mas
// nao quebra usuarios legitimos digitando errado.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,        // 15min
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,    // so conta as falhadas
  message: { message: 'Muitas tentativas de login. Tente novamente em 15 minutos.' }
});

module.exports = { resetSenhaLimiter, loginLimiter };

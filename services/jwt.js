// Servico JWT — assinatura/verificacao com:
//   - secret obrigatoria via env (JWT_SECRET)
//   - algoritmo fixo HS256 (impede ataque "alg: none")
//   - expiresIn 12h (token nao vale eternamente)
//
// Mudar JWT_SECRET invalida todos os tokens emitidos -> usuarios precisam re-logar.

const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

if (!SECRET || SECRET.length < 32) {
  console.error('[JWT] JWT_SECRET ausente ou fraca (precisa >= 32 chars). Gere com: openssl rand -base64 64');
  // Em prod o ideal seria throw — em dev mantemos warning pra nao bloquear quem ainda nao atualizou .env.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET obrigatoria em producao.');
  }
}

const ALG = ['HS256'];

module.exports = () => {
  return {
    generate: (payload) => jwt.sign(payload, SECRET || 'dev-fallback-NAO-USE-EM-PROD', {
      algorithm: ALG[0],
      expiresIn: EXPIRES_IN
    }),
    verify: (token) => jwt.verify(token, SECRET || 'dev-fallback-NAO-USE-EM-PROD', {
      algorithms: ALG
    })
  };
};

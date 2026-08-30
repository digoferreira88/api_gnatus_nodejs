// services/verificationService.js
const crypto = require('crypto');

/**
 * Gera um código de verificação numérico de 6 dígitos.
 * Usa crypto.randomInt (CSPRNG) — Math.random() (V8 xorshift128+) é previsível
 * a partir de algumas saídas observadas, inaceitável p/ código de reset de senha.
 * @returns {string} O código de 6 dígitos como uma string.
 */
const generateVerificationCode = () => String(crypto.randomInt(100000, 1000000));

module.exports = { generateVerificationCode };

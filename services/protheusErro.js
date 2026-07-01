// services/protheusErro.js — detecta erros de CONEXÃO com o Protheus (SQL 1433
// ou API REST) causados por link caído/instável, para distingui-los de erros de
// negócio e mostrar ao usuário uma mensagem clara em vez de "fetch failed".

const CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ETIMEOUT', 'ENOTFOUND', 'ECONNRESET', 'ECONNCLOSED',
  'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE', 'ESOCKET',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT'
]);

function ehConexao(err) {
  if (!err) return false;
  const code = String(err.code || (err.cause && err.cause.code) || '');
  if (CODES.has(code)) return true;
  const msg = String(err.message || '') + ' ' + String((err.cause && err.cause.message) || '');
  return /fetch failed|network|socket hang up|timeout|ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|connection is closed|failed to connect/i.test(msg);
}

const MSG_INDISPONIVEL = 'Protheus temporariamente inacessível (instabilidade de link). Tente novamente em instantes.';

module.exports = { ehConexao, MSG_INDISPONIVEL };

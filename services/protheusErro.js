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
  if (err.name === 'AbortError') return true;   // timeout do AbortController
  const code = String(err.code || (err.cause && err.cause.code) || '');
  if (CODES.has(code)) return true;
  const msg = String(err.message || '') + ' ' + String((err.cause && err.cause.message) || '');
  return /fetch failed|network|socket hang up|timeout|aborted|ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|connection is closed|failed to connect/i.test(msg);
}

const MSG_INDISPONIVEL = 'Protheus temporariamente inacessível (instabilidade de link). Tente novamente em instantes.';

// Chama uma URL do Protheus REST com TIMEOUT e RETRY automático em falhas
// TRANSITÓRIAS (rede/timeout, HTTP 500, HTTP 503). NUNCA faz retry em respostas
// determinísticas (400/403/404/409) — repetir não muda o resultado.
// Retorna { ok, status, txt } da última tentativa; lança o erro se a conexão
// falhar em todas as tentativas.
// ⚠️ Em ações (aprovar/borderô): é SEGURO contra dupla execução PORQUE o caller
// trata "já liberado" (409) como sucesso — se a 1ª chamada efetivou mas a resposta
// se perdeu, a retry recebe 409 e o objetivo já está cumprido.
async function fetchProtheusComRetry(url, opts = {}, { tentativas = 2, timeoutMs = 30000 } = {}) {
  let ultimaResp = null;
  for (let i = 1; i <= tentativas; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      ultimaResp = { ok: r.ok, status: r.status, txt: await r.text() };
      if (!r.ok && (r.status === 500 || r.status === 503) && i < tentativas) continue; // transitório -> retry
      return ultimaResp;
    } catch (e) {
      clearTimeout(timer);
      if (i < tentativas) continue;   // rede/timeout -> tenta de novo
      throw e;
    }
  }
  return ultimaResp;   // esgotou as tentativas em 500/503 -> devolve a última resposta
}

// Protheus respondeu que o documento JÁ está aprovado/liberado (objetivo já
// atingido). O AprovaCompras devolve 409 em DUAS redações:
//   "... ja esta liberado/liberada."
//   "Documento ja foi liberado por outro aprovador (propagacao)." (grupo multi-aprovador)
// Ambas = objetivo cumprido → tratar como sucesso (senão o aprovador vê "erro" e
// reenvia várias vezes — caso Ana Carloni / PC 024928, 27/07/2026).
const jaLiberadoNoProtheus = (status, txt) => status === 409 && /j[aá]\s+(est[aá]|foi)\s+liber/i.test(String(txt || ''));

// Extrai a mensagem de NEGÓCIO que o Protheus devolveu, pra mostrar ao usuário no
// lugar de um "Protheus retornou erro." genérico. O AprovaCompras responde
// {"errorCode":403,"errorMessage":"..."}; outros endpoints usam message/msg/errorMsg.
// Sem isso o aprovador não descobre o motivo e reenvia várias vezes (caso Ana
// Carloni / PC 025100, 11/08/2026: 5 tentativas contra um 403 de limite de alçada).
function mensagemProtheus(txt, fallback = 'Protheus retornou erro.') {
  const bruto = String(txt || '').trim();
  if (!bruto) return fallback;
  try {
    const j = JSON.parse(bruto);
    const m = j && (j.errorMessage || j.message || j.msg || j.errorMsg || j.Mensagem);
    if (m && String(m).trim()) return String(m).trim().slice(0, 300);
  } catch { /* não é JSON — cai no texto puro abaixo */ }
  // texto puro: só devolve se for curto o bastante pra ser mensagem (não um HTML de erro)
  return (bruto.length <= 300 && !/^\s*</.test(bruto)) ? bruto : fallback;
}

module.exports = { ehConexao, MSG_INDISPONIVEL, fetchProtheusComRetry, jaLiberadoNoProtheus, mensagemProtheus };

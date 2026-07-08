// services/protheusClassificacao.js — classifica uma PRÉ-NOTA de entrada no
// Protheus (preenche TES por item e efetiva a entrada — F1_STATUS '' -> 'A')
// via endpoint REST custom (Diego), mesmo padrão do gerar-bordero.
//
// Contrato (spec em docs/spec-protheus-classificacao-prenota.md):
//   POST {PROTHEUS_API_URL}{PROTHEUS_API_PATH_CLASSIFICAR|/Recebimento/classificar}
//   Auth Basic (PROTHEUS_API_USER/PROTHEUS_API_PASS)
//   Body: { filial, doc, serie, fornecedor, loja, operador, observacao, itens:[{item, tes}] }
//   Response ok: { ok:true, doc, qt_itens, mensagem }
//   Response erro: { ok:false, codigo_erro, mensagem }
//
// ⚠️ Endpoint AINDA NÃO PUBLICADO no Protheus — enquanto o Diego não sobe a
// rotina, as chamadas retornam 404/erro e o resource devolve 502 com aviso claro.

const { fetchProtheusComRetry } = require('./protheusErro');

const trim = (v) => String(v || '').trim();

function config() {
  const base = trim(process.env.PROTHEUS_API_URL).replace(/\/$/, '');
  const path = trim(process.env.PROTHEUS_API_PATH_CLASSIFICAR) || '/Recebimento/classificar';
  return {
    url: base + path,
    user: trim(process.env.PROTHEUS_API_USER),
    pass: trim(process.env.PROTHEUS_API_PASS),
    configurado: !!(base && trim(process.env.PROTHEUS_API_USER))
  };
}

// Retorna { ok, httpStatus, body } — nunca lança por status HTTP; lança só
// em falha de conexão esgotada (caller trata com ehConexao).
async function classificar({ filial = '01', doc, serie, fornecedor, loja, operador, observacao, itens }) {
  const cfg = config();
  if (!cfg.configurado) {
    return { ok: false, httpStatus: 503, body: { message: 'API Protheus não configurada (PROTHEUS_API_URL/USER/PASS).' } };
  }
  const auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');
  const { ok, status, txt } = await fetchProtheusComRetry(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ filial, doc, serie, fornecedor, loja, operador, observacao: observacao || '', itens })
  }, { tentativas: 2, timeoutMs: 120000 });   // classificação roda ExecAuto — pode demorar

  let body;
  try { body = JSON.parse(txt); } catch { body = { raw: String(txt || '').slice(0, 800) }; }
  return { ok, httpStatus: status, body };
}

module.exports = { classificar, config };

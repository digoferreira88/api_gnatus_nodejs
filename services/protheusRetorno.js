// Wrapper pro endpoint REST custom Diego "Cobranca/importar-retorno".
// Recebe o conteudo de um arquivo de retorno (.RET, CNAB 240/400) em base64 e
// manda pro Protheus processar. Em simular:true e' dry-run (parse + cruzamento
// com a SE1, NAO grava). Em simular:false salva o arquivo e chama FINA205()
// (registro/baixa de verdade) — operacao de ESCRITA.
//
// Endpoint: POST {PROTHEUS_API_URL}/Cobranca/importar-retorno
// Auth:     Basic admin:*** (PROTHEUS_API_USER / PROTHEUS_API_PASS)
// Spec:     docs/spec-protheus-rest-importar-retorno.md
//
// ⚠️ A Intranet so LE o Protheus; quem grava aqui e' a FINA205 (via Diego).

// Import real (FINA205) pode demorar — timeout generoso. Dry-run e' rapido.
const TIMEOUT_MS = 120000;
const trim = (v) => String(v || '').trim();

/**
 * Importa (ou simula) um arquivo de retorno bancario.
 * @param {object} a
 * @param {string} a.filial            — '01'
 * @param {string} [a.banco]           — '341' etc (opcional; auto-detect pelo header)
 * @param {string} [a.agencia]
 * @param {string} [a.conta]
 * @param {string} [a.nomeArquivo]
 * @param {string} [a.conteudoBase64]  — conteudo do .RET em base64 (ou use conteudoTexto)
 * @param {string} [a.conteudoTexto]
 * @param {string} [a.operador]
 * @param {boolean} a.simular          — true = dry-run (nao grava)
 * @returns {Promise<{ok, httpStatus, body}>}
 */
async function importar({ filial, banco, agencia, conta, nomeArquivo, conteudoBase64, conteudoTexto, operador, simular }) {
  const apiUrl  = process.env.PROTHEUS_API_URL;
  const apiUser = process.env.PROTHEUS_API_USER;
  const apiPass = process.env.PROTHEUS_API_PASS;
  const path    = process.env.PROTHEUS_API_PATH_IMPORTAR_RETORNO || '/Cobranca/importar-retorno';

  if (!apiUrl || !apiUser || !apiPass) {
    return { ok: false, httpStatus: 503, body: { ok: false, codigo_erro: 'CONFIG', mensagem: 'API Protheus nao configurada.' } };
  }
  if (!trim(conteudoBase64) && !trim(conteudoTexto)) {
    return { ok: false, httpStatus: 400, body: { ok: false, codigo_erro: 'SEM_ARQUIVO', mensagem: 'Conteudo do arquivo (.RET) nao informado.' } };
  }

  const url = apiUrl.replace(/\/$/, '') + path;
  const auth = 'Basic ' + Buffer.from(`${apiUser}:${apiPass}`).toString('base64');

  const payload = {
    filial: trim(filial) || '01',
    simular: simular !== false,           // default seguro: dry-run
    operador: trim(operador)
  };
  if (trim(banco))   payload.banco = trim(banco);
  if (trim(agencia)) payload.agencia = trim(agencia);
  if (trim(conta))   payload.conta = trim(conta);
  if (trim(nomeArquivo)) payload.nome_arquivo = trim(nomeArquivo);
  if (trim(conteudoBase64)) payload.conteudo_base64 = trim(conteudoBase64);
  else payload.conteudo_texto = conteudoTexto;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const txt = await r.text();
    let body;
    try { body = JSON.parse(txt); }
    catch { body = { ok: false, codigo_erro: 'RESPOSTA_INVALIDA', mensagem: 'Resposta do Protheus nao eh JSON.', raw: txt.slice(0, 500) }; }
    return { ok: r.ok && body?.ok === true, httpStatus: r.status, body };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    return {
      ok: false, httpStatus: 504,
      body: { ok: false, codigo_erro: isTimeout ? 'TIMEOUT' : 'ERRO_REDE', mensagem: isTimeout ? `Timeout apos ${TIMEOUT_MS / 1000}s` : `Falha de rede: ${err.message}` }
    };
  }
}

module.exports = { importar };

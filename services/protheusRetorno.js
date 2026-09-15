// Wrapper pro endpoint REST custom Diego "Cobranca/importar-retorno".
// Recebe o conteudo de um arquivo de retorno (.RET, CNAB 240/400) em base64 e
// manda pro Protheus processar:
//   simular:true  -> dry-run (parse + cruzamento com a SE1, NAO grava)
//   simular:false -> o endpoint grava o REGISTRO (E1_OCORREN / E1_NUMBCO)
//   baixar:true   -> tambem BAIXA as ocorrencias de liquidacao via MSExecAuto
//                    FINA070 (build R39+). Grava SE1 + SE5 + contabil.
//
// ⚠️ A FINA205 NAO roda headless: o registro e' gravado pelo proprio endpoint
// e a baixa pela FINA070. A intranet so LE o Protheus; quem grava e' o Diego.
//
// Endpoint: POST {PROTHEUS_API_URL}/Cobranca/importar-retorno
// Auth:     Basic (PROTHEUS_API_USER / PROTHEUS_API_PASS)
// Specs:    docs/spec-protheus-rest-importar-retorno.md
//           docs/spec-diego-baixa-retorno-fina070.md (baixa)

// O registro leva ~35-45s no endpoint. A baixa real roda FINA070 titulo a
// titulo e pode passar disso com folga. O teto fica ABAIXO do
// proxy_read_timeout do nginx da intranet (300s): assim quem corta e' o Node,
// com erro estruturado, e nao o nginx com um 504 em HTML.
const TIMEOUT_MS = 120000;
const TIMEOUT_BAIXA_REAL_MS = 280000;
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
 * @param {boolean} [a.baixar]         — true = processa tambem a baixa (FINA070)
 * @returns {Promise<{ok, httpStatus, body}>}
 */
async function importar({ filial, banco, agencia, conta, nomeArquivo, conteudoBase64, conteudoTexto, operador, simular, baixar }) {
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
  // So envia quando for true: sem a baixa, o payload fica identico ao de antes
  // (o endpoint trata ausente como false).
  if (baixar === true) payload.baixar = true;
  if (trim(banco))   payload.banco = trim(banco);
  if (trim(agencia)) payload.agencia = trim(agencia);
  if (trim(conta))   payload.conta = trim(conta);
  if (trim(nomeArquivo)) payload.nome_arquivo = trim(nomeArquivo);
  if (trim(conteudoBase64)) payload.conteudo_base64 = trim(conteudoBase64);
  else payload.conteudo_texto = conteudoTexto;

  const timeoutMs = (baixar === true && payload.simular === false) ? TIMEOUT_BAIXA_REAL_MS : TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
    const baixaReal = baixar === true && payload.simular === false;
    // Timeout na baixa real NAO significa que nada foi baixado: o Protheus
    // continua processando depois que desistimos de esperar.
    const msgTimeout = baixaReal
      ? `Timeout apos ${timeoutMs / 1000}s. O Protheus pode ter concluido a baixa mesmo assim: sincronize os lotes em "Histórico de lotes" antes de tentar de novo.`
      : `Timeout apos ${timeoutMs / 1000}s`;
    return {
      ok: false, httpStatus: 504,
      body: { ok: false, codigo_erro: isTimeout ? 'TIMEOUT' : 'ERRO_REDE', mensagem: isTimeout ? msgTimeout : `Falha de rede: ${err.message}` }
    };
  }
}

module.exports = { importar };

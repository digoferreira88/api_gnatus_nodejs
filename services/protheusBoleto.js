// Wrapper pro endpoint REST custom Diego "Cobranca/boleto-linha".
// Devolve a linha digitavel (e codigo de barras) de um titulo JA registrado no
// banco. A linha nao fica gravada na base (E1_CODBAR/E1_CODDIG vazios) — o
// Protheus gera na impressao, entao buscamos via REST.
//
// Endpoint: GET {PROTHEUS_API_URL}/Cobranca/boleto-linha?filial&prefixo&numero&parcela&cliente&loja
// Auth:     Basic admin:*** (PROTHEUS_API_USER / PROTHEUS_API_PASS)
// Spec:     docs/spec-protheus-rest-boleto-linha.md
//
// ⚠️ O endpoint do Diego pode ainda nao existir — neste caso retorna
//    {ok:false, codigo_erro:'INDISPONIVEL'} e a UI mostra "linha indisponivel".

const TIMEOUT_MS = 30000;
const trim = (v) => String(v || '').trim();

// Convenios bancarios da Gnatus por banco (codigo cedente que o Diego procura
// em MV_CONV<BBB> ou aceita via ?convenio=). Mantemos aqui pra evitar dependencia
// de parametro Protheus que precisaria ser cadastrado pelo financeiro/Diego.
//   033 (Santander): 3418790 — extraido de boleto antigo da Gnatus (2026-05-28).
//                    Validado: gera linha digitavel correta com carteira 101.
//   341 (Itau): nao precisa — Diego hardcoda cCart='109' direto no AdvPL.
const CONVENIO_POR_BANCO = {
  '033': '3418790'
};

/**
 * Busca a linha digitavel de um titulo registrado.
 * @returns {Promise<{ok, httpStatus, body}>}
 *   body em sucesso: { ok:true, linha_digitavel, codigo_barras, nosso_numero, banco, vencimento, valor }
 */
async function linhaDigitavel({ filial, prefixo, numero, parcela, cliente, loja, tipo, banco }) {
  const apiUrl  = process.env.PROTHEUS_API_URL;
  const apiUser = process.env.PROTHEUS_API_USER;
  const apiPass = process.env.PROTHEUS_API_PASS;
  const path    = process.env.PROTHEUS_API_PATH_BOLETO_LINHA || '/Cobranca/boleto-linha';

  if (!apiUrl || !apiUser || !apiPass) {
    return { ok: false, httpStatus: 503, body: { ok: false, codigo_erro: 'CONFIG', mensagem: 'API Protheus nao configurada.' } };
  }

  // Convenio injetado automaticamente pra bancos que precisam (ex.: Santander 033)
  const convenio = CONVENIO_POR_BANCO[trim(banco)];

  const qs = new URLSearchParams({
    filial: trim(filial) || '01',
    prefixo: trim(prefixo),
    numero: trim(numero),
    parcela: trim(parcela),
    cliente: trim(cliente),
    loja: trim(loja),
    ...(trim(tipo) ? { tipo: trim(tipo) } : {}),
    ...(convenio ? { convenio } : {})
  }).toString();

  const url = apiUrl.replace(/\/$/, '') + path + '?' + qs;
  const auth = 'Basic ' + Buffer.from(`${apiUser}:${apiPass}`).toString('base64');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'GET', headers: { Authorization: auth, Accept: 'application/json' }, signal: ctrl.signal });
    clearTimeout(timer);
    const txt = await r.text();
    let body;
    try { body = JSON.parse(txt); }
    catch {
      // 404 generico do AppServer quando a rota ainda nao existe
      return { ok: false, httpStatus: r.status, body: { ok: false, codigo_erro: 'INDISPONIVEL', mensagem: 'Endpoint de linha digitavel ainda nao disponivel no Protheus.', raw: txt.slice(0, 300) } };
    }
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

module.exports = { linhaDigitavel };

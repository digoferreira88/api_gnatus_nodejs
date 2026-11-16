// services/protheusPedidoVenda.js — chamada ao REST custom do Diego que cadastra o
// cliente (se faltar) e cria o pedido de venda no Protheus (MATA030 + MATA410).
// Usado pelo botão "Inserir no Protheus e finalizar" do CIOSP.
//
// Endpoint: POST {PROTHEUS_API_URL}{PROTHEUS_API_PATH_PEDIDO_VENDA || '/PedidoVenda/incluir'}
// Auth:     Basic (PROTHEUS_API_USER / PROTHEUS_API_PASS — as mesmas do SolicCompra)
// Timeout:  180 s (PROTHEUS_PV_TIMEOUT_MS só para teste local)
//
// ESCRITA NO ERP. Só repete no 503: o appserver recusa por falta de licença ANTES de
// rodar o código, então nada foi gravado. Timeout, rede e 500 NÃO repetem — o pedido
// pode ter sido criado; quem resolve é o "Tentar de novo" do ADM, que reenvia o mesmo
// id_externo (o endpoint responde JA_EXISTIA).
//
// Aqui só se fala HTTP; o significado da resposta está em ciospProtheusEnvio.js.

const ESPERA_RETRY_MS = 2500;
const trim = (v) => String(v == null ? '' : v).trim();
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

async function uma(url, auth, corpo, fetchImpl, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: corpo,
      signal: ctrl.signal
    });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    return { http: r.status, corpo: json, erro: null };
  } catch (err) {
    return { http: 0, corpo: null, erro: err && err.name === 'AbortError' ? 'TIMEOUT' : 'REDE', detalhe: err && err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{ http: number, corpo: object|null, erro: null|'TIMEOUT'|'REDE'|'CONFIG', duracao_ms: number, tentativas: number }>}
 */
async function incluirPedido(payload, opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || Number(env.PROTHEUS_PV_TIMEOUT_MS) || 180000;
  const esperaRetryMs = opts.esperaRetryMs != null ? opts.esperaRetryMs : ESPERA_RETRY_MS;

  const base = trim(env.PROTHEUS_API_URL);
  const usuario = trim(env.PROTHEUS_API_USER);
  const senha = trim(env.PROTHEUS_API_PASS);
  if (!base || !usuario || !senha) {
    return { http: 0, corpo: null, erro: 'CONFIG', duracao_ms: 0, tentativas: 0 };
  }

  const url = base.replace(/\/+$/, '') + (trim(env.PROTHEUS_API_PATH_PEDIDO_VENDA) || '/PedidoVenda/incluir');
  const auth = 'Basic ' + Buffer.from(`${usuario}:${senha}`).toString('base64');
  const corpo = JSON.stringify(payload);
  const inicio = Date.now();

  let r = await uma(url, auth, corpo, fetchImpl, timeoutMs);
  let tentativas = 1;
  if (r.http === 503) {
    await dormir(esperaRetryMs);
    r = await uma(url, auth, corpo, fetchImpl, timeoutMs);
    tentativas = 2;
  }
  return { http: r.http, corpo: r.corpo, erro: r.erro, duracao_ms: Date.now() - inicio, tentativas };
}

module.exports = { incluirPedido };

// services/shopifyApi.js — cliente da Admin GraphQL API do Shopify.
//
// Autenticação: custom app instalado na PRÓPRIA loja (não é app de CLI/Partner, não
// tem OAuth). O token sai do painel da loja e vive no .env como SHOPIFY_TOKEN.
// Escopos usados nesta entrega: read_products + write_products. Só isso.
//
// Usamos GraphQL porque a Admin REST de produtos é legado.
//
// THROTTLE: a Admin GraphQL não limita por nº de chamadas e sim por CUSTO calculado
// (leaky bucket, ~100 pontos/s no plano padrão). Cada resposta traz o saldo em
// `extensions.cost.throttleStatus` — lemos e esperamos o bucket reencher ANTES de
// levar 429, em vez de reagir ao erro.

const trim = (v) => String(v == null ? '' : v).trim();

// Aceita o domínio colado de qualquer jeito: "loja.myshopify.com",
// "https://loja.myshopify.com/" ou com caminho. Guardamos só o host — sem isso a URL
// virava "https://https://loja.myshopify.com//admin/api/..." e nada funcionava.
const SHOP = () => trim(process.env.SHOPIFY_SHOP)
  .replace(/^https?:\/\//i, '')
  .replace(/\/.*$/, '')
  .toLowerCase();

// ---------------------------------------------------------------------------
// AUTENTICAÇÃO — dois caminhos, porque o Shopify tem dois tipos de custom app
//
// 1) App do DEV DASHBOARD (o fluxo atual): NÃO existe token fixo para copiar. O
//    token se obtém pelo *client credentials grant* a partir do client id +
//    secret, e **vale 24 horas** (`expires_in: 86399`). Não há refresh token:
//    para renovar, repete-se a mesma requisição. Por isso o token é buscado e
//    cacheado aqui dentro, e não colado no .env.
// 2) Custom app LEGADO (criado antes de 2026): tem um Admin API access token
//    fixo (`shpat_`). Se `SHOPIFY_TOKEN` estiver preenchido com um, ele vence.
const CLIENT_ID = () => trim(process.env.SHOPIFY_CLIENT_ID);
const CLIENT_SECRET = () => trim(process.env.SHOPIFY_CLIENT_SECRET);
const TOKEN_FIXO = () => {
  const t = trim(process.env.SHOPIFY_TOKEN);
  return /^shp(at|ca)_/.test(t) ? t : '';
};

let tokenCache = null;    // { valor, expiraEm }  — expiraEm em ms epoch
let buscandoToken = null; // dedup de concorrência

// Margem para não usar um token que expira no meio de um ciclo longo.
const MARGEM_EXPIRA_MS = 5 * 60 * 1000;

async function trocarPorToken() {
  const r = await fetch(`https://${SHOP()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID(),
      client_secret: CLIENT_SECRET(),
      grant_type: 'client_credentials'
    }),
    signal: AbortSignal.timeout(20000)
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = {}; }
  if (!r.ok || !j.access_token) {
    const detalhe = j.error_description || j.error || txt.slice(0, 200) || `HTTP ${r.status}`;
    throw new Error(`Shopify (client_credentials): ${detalhe}`);
  }
  const segundos = Number(j.expires_in) > 0 ? Number(j.expires_in) : 86399;
  return { valor: trim(j.access_token), expiraEm: Date.now() + segundos * 1000 };
}

async function obterToken() {
  const fixo = TOKEN_FIXO();
  if (fixo) return fixo;
  if (!CLIENT_ID() || !CLIENT_SECRET()) {
    throw new Error('Shopify sem credencial: defina SHOPIFY_CLIENT_ID e SHOPIFY_CLIENT_SECRET (ou um SHOPIFY_TOKEN shpat_).');
  }
  if (tokenCache && tokenCache.expiraEm - MARGEM_EXPIRA_MS > Date.now()) return tokenCache.valor;
  if (!buscandoToken) {
    buscandoToken = trocarPorToken()
      .then((t) => { tokenCache = t; buscandoToken = null; return t; })
      .catch((e) => { buscandoToken = null; throw e; });
  }
  return (await buscandoToken).valor;
}

const invalidarToken = () => { tokenCache = null; };

// Diagnóstico de credencial mal colada — os três valores da tela do app são
// parecidos e o erro da API ("Invalid API key or access token") não diz qual é qual.
function diagnosticoToken() {
  const bruto = trim(process.env.SHOPIFY_TOKEN);
  if (CLIENT_ID() && CLIENT_SECRET()) return null;
  if (TOKEN_FIXO()) return null;
  if (CLIENT_ID() && !CLIENT_SECRET()) return 'SHOPIFY_CLIENT_ID está preenchido, falta SHOPIFY_CLIENT_SECRET (o valor shpss_ da tela do app).';
  if (!CLIENT_ID() && CLIENT_SECRET()) return 'SHOPIFY_CLIENT_SECRET está preenchido, falta SHOPIFY_CLIENT_ID (a API key, hex de 32 caracteres).';
  if (!bruto) return 'Defina SHOPIFY_CLIENT_ID e SHOPIFY_CLIENT_SECRET (app do Dev Dashboard) ou SHOPIFY_TOKEN com um Admin API access token shpat_ (app legado).';
  if (bruto.startsWith('shpss_')) return 'SHOPIFY_TOKEN tem o client secret (shpss_). Num app do Dev Dashboard ele vai em SHOPIFY_CLIENT_SECRET, junto com o client id em SHOPIFY_CLIENT_ID — não existe token fixo para colar.';
  if (/^[0-9a-f]{32}$/i.test(bruto)) return 'SHOPIFY_TOKEN tem o client id (API key). Num app do Dev Dashboard ele vai em SHOPIFY_CLIENT_ID, junto com o secret em SHOPIFY_CLIENT_SECRET — não existe token fixo para colar.';
  return `SHOPIFY_TOKEN começa com "${bruto.slice(0, 6)}…", que não é um Admin API access token (shpat_).`;
}
const TOKEN = () => trim(process.env.SHOPIFY_TOKEN);
// Versões saem a cada trimestre e cada uma vive no mínimo 12 meses. Em 29/09/2026 a
// atual é 2026-07 e só de 2025-10 em diante segue suportada.
//
// ⚠️ Pedir uma versão fora de suporte NÃO dá erro: o Shopify serve a estável mais
// antiga disponível e só conta isso no header X-Shopify-API-Version. Ou seja, o
// comportamento muda sem ninguém perceber. Por isso conferimos o header em toda
// resposta (avisoVersao) e o default aqui precisa ser revisto de tempos em tempos.
const VERSAO = () => trim(process.env.SHOPIFY_API_VERSION) || '2026-07';
let avisoVersao = null;   // preenchido quando a loja responde numa versão diferente
const configurado = () => !!SHOP() && (!!TOKEN_FIXO() || (!!CLIENT_ID() && !!CLIENT_SECRET()));

const endpoint = () => `https://${SHOP()}/admin/api/${VERSAO()}/graphql.json`;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Folga mínima no bucket antes de disparar a próxima query.
//
// ⚠️ Não pode ser uma constante pequena: o Shopify exige que o bucket tenha o
// `requestedQueryCost` INTEIRO disponível antes de executar. Uma folga fixa de 200
// liberava a chamada com 450 pontos para uma query que custa ~550 — e a resposta
// voltava THROTTLED. Por isso guardamos o custo real da última resposta e exigimos
// esse custo (com margem) da próxima.
const FOLGA_PISO = 100;
const MARGEM = 1.25;
let ultimoThrottle = null;
let ultimoCusto = 0;         // requestedQueryCost da última resposta

function folgaExigida() {
  return Math.max(FOLGA_PISO, Math.ceil(ultimoCusto * MARGEM));
}

// Espera o bucket reencher quando o saldo está baixo. restoreRate vem em pontos/s.
async function aguardarFolga() {
  const t = ultimoThrottle;
  if (!t) return;
  const alvo = folgaExigida();
  if (t.currentlyAvailable >= alvo) return;
  const faltam = alvo - t.currentlyAvailable;
  const taxa = t.restoreRate > 0 ? t.restoreRate : 50;
  const espera = Math.min(15000, Math.ceil((faltam / taxa) * 1000));
  if (espera > 0) {
    await dormir(espera);
    // O bucket reencheu durante a espera; refletimos isso para não dormir de novo
    // na próxima chamada com base num saldo velho.
    ultimoThrottle = { ...t, currentlyAvailable: Math.min(t.maximumAvailable || alvo, t.currentlyAvailable + Math.ceil((espera / 1000) * taxa)) };
  }
}

async function gql(query, variables = {}, _retry = 3) {
  if (!configurado()) throw new Error('Shopify não configurado — ' + (diagnosticoToken() || 'defina SHOPIFY_SHOP no .env.'));

  await aguardarFolga();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let r;
  try {
    r = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await obterToken()
      },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'Shopify: timeout (30s)' : `Shopify: ${e.message}`);
  }
  clearTimeout(timer);

  // 401 com token obtido por client_credentials: ele vale 24h e pode ter vencido
  // (ou sido revogado) no meio de um ciclo longo. Descarta o cache e refaz uma vez.
  if (r.status === 401 && _retry > 0 && !TOKEN_FIXO()) {
    invalidarToken();
    return gql(query, variables, _retry - 1);
  }

  // 429 = estouramos o bucket mesmo assim. Respeita o Retry-After e tenta 1 vez.
  if (r.status === 429 && _retry > 0) {
    const espera = Number(r.headers.get('Retry-After') || 2) * 1000;
    await dormir(espera);
    return gql(query, variables, _retry - 1);
  }

  // A loja diz aqui em QUE versão ela realmente atendeu. Se for diferente da que
  // pedimos, caímos no fallback silencioso de versão retirada — precisa aparecer.
  const servida = trim(r.headers.get('X-Shopify-API-Version'));
  if (servida && servida !== VERSAO()) {
    if (avisoVersao !== servida) {
      console.warn(`[shopify] ⚠️ pedimos a API ${VERSAO()} e a loja respondeu ${servida} — versão pedida provavelmente fora de suporte. Ajuste SHOPIFY_API_VERSION.`);
    }
    avisoVersao = servida;
  } else if (servida) {
    avisoVersao = null;
  }

  const j = await r.json().catch(() => ({}));

  const custo = j?.extensions?.cost;
  if (custo) {
    if (Number(custo.requestedQueryCost) > 0) ultimoCusto = Number(custo.requestedQueryCost);
    const t = custo.throttleStatus;
    if (t) {
      ultimoThrottle = {
        currentlyAvailable: Number(t.currentlyAvailable || 0),
        restoreRate: Number(t.restoreRate || 0),
        maximumAvailable: Number(t.maximumAvailable || 0)
      };
    }
  }

  if (!r.ok) {
    const detalhe = j?.errors ? JSON.stringify(j.errors).slice(0, 300) : `HTTP ${r.status}`;
    throw new Error(`Shopify: ${detalhe}`);
  }

  if (Array.isArray(j.errors) && j.errors.length) {
    // ⚠️ O limite por CUSTO da Admin GraphQL NÃO vem como 429: vem HTTP 200 com
    // errors[].extensions.code = 'THROTTLED'. Sem tratar aqui, um throttle
    // transitório (que custaria 2s de espera) virava erro fatal — abortava o seed
    // inteiro e marcava produtos com status 'erro' sem necessidade.
    const throttled = j.errors.some((e) => e?.extensions?.code === 'THROTTLED');
    if (throttled && _retry > 0) {
      const t = j?.extensions?.cost?.throttleStatus;
      const pedido = Number(j?.extensions?.cost?.requestedQueryCost || ultimoCusto || 100);
      const disp = Number(t?.currentlyAvailable || 0);
      const taxa = Number(t?.restoreRate) > 0 ? Number(t.restoreRate) : 50;
      const espera = Math.min(20000, Math.max(1000, Math.ceil(((pedido - disp) / taxa) * 1000)));
      await dormir(espera);
      return gql(query, variables, _retry - 1);
    }
    throw new Error(`Shopify: ${j.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
  }
  return j.data;
}

// `userErrors` não vem como erro de transporte: a chamada retorna 200 e o erro está
// dentro do payload da mutation. Sem checar isso, uma falha de negócio passaria por
// sucesso e o estado em Postgres ficaria mentindo.
function checarUserErrors(bloco, ondeERRO) {
  const erros = bloco?.userErrors || [];
  if (erros.length) {
    const msg = erros.map((e) => `${(e.field || []).join('.')}: ${e.message}`).join('; ');
    throw new Error(`${ondeERRO}: ${msg}`.slice(0, 400));
  }
}

// Diagnóstico de credencial/escopo, usado pela tela de status.
async function verificarAcesso() {
  const d = await gql(`{ shop { name myshopifyDomain currencyCode } }`);
  return {
    nome: trim(d?.shop?.name),
    dominio: trim(d?.shop?.myshopifyDomain),
    moeda: trim(d?.shop?.currencyCode)
  };
}

module.exports = {
  gql,
  checarUserErrors,
  verificarAcesso,
  configurado,
  SHOP,
  VERSAO,
  get throttle() { return ultimoThrottle; },
  get versaoServida() { return avisoVersao; },
  diagnosticoToken
};

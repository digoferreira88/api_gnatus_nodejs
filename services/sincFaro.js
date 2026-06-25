// services/sincFaro.js — adapter da FARO (SINC Finance): "Sistema de análise de
// risco de crédito". Executa um WORKFLOW configurado na Faro (assíncrono) e
// busca o resultado (plugin_data por bureau + output_data da decisão).
//
// Auth: OAuth2 client_credentials (Keycloak), token cacheado. Config no .env:
//   SINC_FARO_TOKEN_URL, SINC_FARO_BASE_URL, SINC_FARO_CLIENT_ID,
//   SINC_FARO_CLIENT_SECRET, SINC_FARO_CUSTOMER_ID, SINC_FARO_WORKFLOW_ID
//
// IMPORTANTE: ainda NÃO normaliza o resultado para os indicadores do módulo de
// crédito — o shape de plugin_data/output_data é definido pelo workflow (que
// ainda não foi publicado). Quando houver um workflow + um resultado de
// exemplo, escrever `normalizar(result)` e plugar no services/creditoBureau.

const TOKEN_URL = () => (process.env.SINC_FARO_TOKEN_URL || '').trim();
const BASE = () => (process.env.SINC_FARO_BASE_URL || '').trim().replace(/\/$/, '');
const CLIENT_ID = () => (process.env.SINC_FARO_CLIENT_ID || '').trim();
const CLIENT_SECRET = () => (process.env.SINC_FARO_CLIENT_SECRET || '').trim();
const CUSTOMER_ID = () => (process.env.SINC_FARO_CUSTOMER_ID || '').trim();
const WORKFLOW_ID = () => (process.env.SINC_FARO_WORKFLOW_ID || '').trim();

const TERMINAIS = new Set(['completed', 'success', 'failed', 'error', 'expired', 'cancelled']);
let _tok = { value: null, exp: 0 };

async function _fetch(url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

// OAuth2 client_credentials com cache (renova 60s antes de expirar)
async function getToken() {
  const now = Date.now();
  if (_tok.value && now < _tok.exp - 60000) return _tok.value;
  if (!TOKEN_URL() || !CLIENT_ID() || !CLIENT_SECRET()) throw new Error('Faro: SINC_FARO_TOKEN_URL/CLIENT_ID/CLIENT_SECRET não configurados.');
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID(), client_secret: CLIENT_SECRET() });
  const r = await _fetch(TOKEN_URL(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, 15000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Faro auth falhou: ' + (j.error_description || j.error || ('HTTP ' + r.status)));
  _tok = { value: j.access_token, exp: now + (Number(j.expires_in || 300) * 1000) };
  return _tok.value;
}

async function _api(path, opts = {}) {
  if (!BASE() || !CUSTOMER_ID()) throw new Error('Faro: SINC_FARO_BASE_URL/CUSTOMER_ID não configurados.');
  const tok = await getToken();
  const r = await _fetch(BASE() + path, { ...opts, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = txt; }
  if (!r.ok) { const e = new Error(`Faro ${path}: HTTP ${r.status} ${(j && j.detail) || ''}`.trim()); e.status = r.status; e.body = j; throw e; }
  return j;
}

// GET workflows (útil pra descobrir o workflowId depois de publicado)
const listarWorkflows = () => _api(`/faro/v1/customer/${CUSTOMER_ID()}/workflows?pageSize=50`);

// POST executa um workflow (assíncrono) — retorna a execução (com id, status=pending).
// O contrato da Faro EXIGE o envelope { input: { basic_data, custom_data } } — sem o
// wrapper "input" a API responde 400. O document precisa ser CPF/CNPJ válido (400 se não).
const executar = (workflowId, basicData, customData = {}) =>
  _api(`/faro/v1/customer/${CUSTOMER_ID()}/workflows/${workflowId}/execute`,
    { method: 'POST', body: JSON.stringify({ input: { basic_data: basicData, custom_data: customData } }) });

// GET detalhe/resultado de uma execução
const consultarExecucao = (executionId) => _api(`/faro/v1/customer/${CUSTOMER_ID()}/executions/${executionId}`);

// Executa e faz polling até status terminal. Retorna o objeto da execução.
async function analisar(documento, { workflowId, customData = {}, timeoutMs = 60000, intervaloMs = 2500 } = {}) {
  const wf = (workflowId || WORKFLOW_ID());
  if (!wf) throw new Error('Faro: nenhum workflow configurado (SINC_FARO_WORKFLOW_ID vazio — publicar um workflow na Faro primeiro).');
  const doc = String(documento || '').replace(/\D/g, '');
  const exec = await executar(wf, { document: doc }, customData);
  const execId = exec.id || exec.executionId; // resposta 202 traz "id"
  if (!execId) return exec;
  const ate = Date.now() + timeoutMs;
  let ultimo = exec;
  while (Date.now() < ate) {
    await new Promise(r => setTimeout(r, intervaloMs));
    ultimo = await consultarExecucao(execId);
    if (TERMINAIS.has(String(ultimo.status || '').toLowerCase())) return ultimo;
  }
  return ultimo; // timeout: devolve o último estado conhecido
}

const _num = (v) => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// Normaliza a execução da Faro para o formato padrão do módulo de crédito
// (mesmo shape do adapter quod). A DECISÃO do workflow sai em `output_data`;
// os dados de bureau, em `plugin_data`. Defensivo: o que o workflow não
// preencher fica null/zero (o blend usa só o score interno quando score==null).
// Hoje o workflow de testes (6a3c2920…) só ecoa dados → score null; quando o
// workflow real (serasa/bigdatacorp) for publicado e popular o output_data,
// este normalizador já entrega score/protestos/restrições prontos.
function normalizar(exec) {
  const result = (exec && exec.result) || {};
  const out = result.output_data || {};
  const plugins = result.plugin_data || {};
  const pick = (...ks) => { for (const k of ks) if (out[k] != null) return out[k]; return null; };
  return {
    fonte: 'faro',
    score: _num(pick('score', 'scoreExterno', 'score_externo')),
    scoreRaw: pick('score', 'scoreExterno', 'score_externo'),
    classificacao: pick('classificacao', 'classification', 'rating'),
    protestos:  out.protestos  || { ativo: !!pick('protesto_ativo'), qtd: _num(pick('protestos_qtd')) || 0, valor: _num(pick('protestos_valor')) || 0, ultimo: null },
    restricoes: out.restricoes || { qtd: _num(pick('restricoes_qtd')) || 0, valor: _num(pick('restricoes_valor')) || 0, itens: [] },
    pendencias: out.pendencias || { qtd: 0, valor: 0 },
    cadastro:   out.cadastro   || {},
    resumo: pick('resumo', 'summary') || '',
    // rastreabilidade / custo / auditoria
    execId: exec && exec.id,
    workflowId: exec && exec.workflowId,
    status: exec && exec.status,
    custoBRL: (exec && exec.totalCost && exec.totalCost.totalAmount) || 0,
    pluginData: plugins,
    outputData: out
  };
}

const disponivel = () => !!(CLIENT_ID() && CLIENT_SECRET() && CUSTOMER_ID() && WORKFLOW_ID());

module.exports = { getToken, listarWorkflows, executar, consultarExecucao, analisar, normalizar, disponivel, CUSTOMER_ID };

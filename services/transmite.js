// services/transmite.js — adapter do TOTVS Transmite (Monitor de NF-e Recebidas).
// POST {BASE}/api/mdeclient/getnferecebida com body {"Query":"<OData>"} (Bearer).
// Pagina por DhEmi desc e filtra o período no nosso lado.
//
// TOKEN: vem da tabela tab_transmite_config (gerenciável pela tela "Token
// Transmite" do Painel Fiscal, sem SSH), com cache de 30s e fallback p/ o .env
// TRANSMITE_TOKEN. É um token de SESSÃO do Fluig (expira ~48h) — renovar pela
// tela; o scheduler alerta por e-mail quando está perto de expirar.

const Pg = require('./pg');

const BASE = () => (process.env.TRANSMITE_BASE_URL || 'https://api-transmite.totvs.app').replace(/\/$/, '');
const SELECT = 'Numero,Serie,Chave,Emissor,CnpjCpfEmi,Destinatario,VNf,DhEmi,DhRecbto,CStat,IntegracaoERP,Ator,NatOp,Finalidade,SituacaoMDe';

let _tok = null, _tokAt = 0;
function limparCache() { _tok = null; _tokAt = 0; }

// exp (segundos) do JWT, ou null
function decodeExp(tok) {
  try {
    const p = JSON.parse(Buffer.from(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return p.exp || null;
  } catch { return null; }
}

// token vigente: cache 30s -> tab_transmite_config -> fallback .env
async function tokenAtual() {
  const now = Date.now();
  if (_tok !== null && (now - _tokAt) < 30000) return _tok;
  let t = '';
  try {
    const r = await Pg.connectAndQuery(`SELECT token FROM tab_transmite_config WHERE id=1`, {});
    t = (r[0] && String(r[0].token || '').trim()) || '';
  } catch (e) { /* tabela pode não existir ainda */ }
  if (!t) t = String(process.env.TRANSMITE_TOKEN || '').trim();
  _tok = t; _tokAt = now;
  return t;
}

async function _post(query) {
  const TK = await tokenAtual();
  if (!TK) { const e = new Error('Token Transmite não configurado (cadastre na tela "Token Transmite").'); e.status = 503; throw e; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(BASE() + '/api/mdeclient/getnferecebida', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TK, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ Query: query }),
      signal: ctrl.signal
    });
    const txt = await r.text();
    let j; try { j = txt ? JSON.parse(txt) : []; } catch { j = txt; }
    if (r.status === 401) { const e = new Error('Token Transmite expirado/inválido (401) — renove na tela "Token Transmite".'); e.status = 401; throw e; }
    if (!r.ok) { const e = new Error('Transmite HTTP ' + r.status + ' ' + ((j && j.detailedMessage) || '')); e.status = r.status; throw e; }
    return Array.isArray(j) ? j : [];
  } finally { clearTimeout(timer); }
}

// Lista NF-e recebidas com DhEmi no período [inicio, fim] (YYYY-MM-DD).
async function listarRecebidas(inicioISO, fimISO, { maxPaginas = 60, porPagina = 100 } = {}) {
  const ini = inicioISO ? new Date(inicioISO + 'T00:00:00-03:00') : null;
  const fim = fimISO ? new Date(fimISO + 'T23:59:59-03:00') : null;
  const out = [];
  for (let p = 0; p < maxPaginas; p++) {
    const q = `$top=${porPagina}&$skip=${p * porPagina}&$filter=TpAmb eq '1' and ExibirNfe eq true`
      + `&$select=${SELECT}&$expand=SituacaoMDe&$orderby=DhEmi desc,Numero desc,Serie asc`;
    const page = await _post(q);
    if (!page.length) break;
    let passouInicio = false;
    for (const n of page) {
      const d = n.DhEmi ? new Date(n.DhEmi) : null;
      if (fim && d && d > fim) continue;
      if (ini && d && d < ini) { passouInicio = true; continue; }
      out.push(n);
    }
    if (passouInicio) break;
    if (page.length < porPagina) break;
  }
  return out;
}

const disponivel = async () => !!(await tokenAtual());

// Status do token p/ a tela e o alerta.
async function statusToken() {
  let row = null;
  try {
    const r = await Pg.connectAndQuery(`SELECT token, atualizado_por, atualizado_em FROM tab_transmite_config WHERE id=1`, {});
    row = r[0] || null;
  } catch (e) { /* tabela pode não existir */ }
  const dbTok = row && String(row.token || '').trim();
  const tk = dbTok || String(process.env.TRANSMITE_TOKEN || '').trim();
  const fonte = dbTok ? 'cadastrado' : (process.env.TRANSMITE_TOKEN ? '.env (inicial)' : 'nenhum');
  if (!tk) return { temToken: false, fonte };
  const exp = decodeExp(tk);
  const expMs = exp ? exp * 1000 : null;
  const agora = Date.now();
  return {
    temToken: true, fonte,
    expiraEm: expMs ? new Date(expMs).toISOString() : null,
    expirado: expMs ? expMs <= agora : false,
    horasRestantes: expMs ? Math.round((expMs - agora) / 360000) / 10 : null,
    atualizadoPor: (row && row.atualizado_por) || null,
    atualizadoEm: (row && row.atualizado_em) || null
  };
}

// Salva token novo (aceita o JWT puro OU um cURL/texto colado — extrai o JWT).
async function salvarToken(input, por) {
  const m = String(input || '').match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/);
  if (!m) throw new Error('Não encontrei um token JWT (eyJ...) no texto colado.');
  const tk = m[0];
  const exp = decodeExp(tk);
  if (!exp) throw new Error('Token inválido — não consegui ler a expiração.');
  if (exp * 1000 <= Date.now()) throw new Error('Esse token já está expirado. Pegue um token atual no painel do Transmite.');
  await Pg.connectAndQuery(`
    INSERT INTO tab_transmite_config (id, token, expira_em, alertado_em, atualizado_por, atualizado_em)
    VALUES (1, @t, to_timestamp(@e), NULL, @p, NOW())
    ON CONFLICT (id) DO UPDATE SET
      token=@t, expira_em=to_timestamp(@e), alertado_em=NULL, atualizado_por=@p, atualizado_em=NOW()`,
    { t: tk, e: exp, p: por || '' });
  limparCache();
  return await statusToken();
}

module.exports = { listarRecebidas, disponivel, statusToken, salvarToken, decodeExp };

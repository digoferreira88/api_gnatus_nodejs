// services/transmite.js — adapter do TOTVS Transmite (Monitor de NF-e Recebidas).
// POST {BASE}/api/mdeclient/getnferecebida com body {"Query":"<OData>"} (Bearer).
// Pagina por DhEmi desc e filtra o período no nosso lado (o $filter de data da
// API dá 500). Token de SESSÃO (Fluig) no .env TRANSMITE_TOKEN — expira; em
// produção trocar por credencial de serviço (TOTVS API Services).

const BASE = () => (process.env.TRANSMITE_BASE_URL || 'https://api-transmite.totvs.app').replace(/\/$/, '');
const TOKEN = () => (process.env.TRANSMITE_TOKEN || '').trim();
const SELECT = 'Numero,Serie,Chave,Emissor,CnpjCpfEmi,Destinatario,VNf,DhEmi,DhRecbto,CStat,IntegracaoERP,Ator,NatOp,Finalidade,SituacaoMDe';

async function _post(query) {
  if (!TOKEN()) throw new Error('TRANSMITE_TOKEN não configurado no .env.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(BASE() + '/api/mdeclient/getnferecebida', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN(), 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ Query: query }),
      signal: ctrl.signal
    });
    const txt = await r.text();
    let j; try { j = txt ? JSON.parse(txt) : []; } catch { j = txt; }
    if (r.status === 401) { const e = new Error('Token Transmite expirado/inválido (401) — atualize TRANSMITE_TOKEN.'); e.status = 401; throw e; }
    if (!r.ok) { const e = new Error('Transmite HTTP ' + r.status + ' ' + ((j && j.detailedMessage) || '')); e.status = r.status; throw e; }
    return Array.isArray(j) ? j : [];
  } finally { clearTimeout(timer); }
}

// Lista NF-e recebidas com DhEmi no período [inicio, fim] (YYYY-MM-DD).
// Pagina desc por DhEmi e para quando passa do início (ordenado).
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
      if (fim && d && d > fim) continue;                 // mais novo que o período
      if (ini && d && d < ini) { passouInicio = true; continue; }  // mais velho que o início
      out.push(n);
    }
    if (passouInicio) break;                              // desc: passou do início → acabou
    if (page.length < porPagina) break;
  }
  return out;
}

const disponivel = () => !!TOKEN();
module.exports = { listarRecebidas, disponivel };

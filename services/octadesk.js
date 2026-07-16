// services/octadesk.js — abre TICKET no Octadesk a partir de um detrator do NPS.
// API v1 (https://developers.octadesk.com). Autenticação por 2 headers:
//   x-api-key       -> chave de 73 chars (obtida com o suporte Octadesk)
//   octa-agent-email-> e-mail do agente dono da chave
// Endpoint: POST {base}/tickets  (TicketDTO: summary + description obrigatórios;
//   requester {name,email}, tags[] opcionais). Resposta 201.
//
// Env (.env):
//   OCTADESK_API_KEY      (obrigatório)
//   OCTADESK_AGENT_EMAIL  (obrigatório)
//   OCTADESK_API_URL      (default https://api.octadesk.services)
//   OCTADESK_WORKSPACE_URL(opcional — base p/ montar o link do ticket, ex.:
//                          https://gnatus.octadesk.com)

const trim = (v) => String(v == null ? '' : v).trim();

const BASE = () => (trim(process.env.OCTADESK_API_URL) || 'https://api.octadesk.services').replace(/\/$/, '');
const KEY = () => trim(process.env.OCTADESK_API_KEY);
const AGENT = () => trim(process.env.OCTADESK_AGENT_EMAIL);

function configurado() {
  return !!(KEY() && AGENT());
}

// Monta a URL de visualização do ticket (best-effort — depende do workspace).
function linkTicket(number) {
  const ws = trim(process.env.OCTADESK_WORKSPACE_URL).replace(/\/$/, '');
  if (!ws || !number) return '';
  return `${ws}/ticket/${number}`;
}

/**
 * Cria um ticket. dados = {
 *   summary, description,
 *   requesterName, requesterEmail,   // contato do cliente (email associa/cria o contato)
 *   tags: []                          // ex.: ['NPS','Detrator','nota-3']
 * }
 * Retorna { ok, ticketId, number, url, motivo, raw }.
 */
async function criarTicket(dados) {
  if (!configurado()) return { ok: false, motivo: 'nao_configurado' };

  const body = {
    summary: trim(dados.summary).slice(0, 250) || 'NPS — cliente detrator',
    description: trim(dados.description) || 'Cliente detrator na pesquisa de pós-venda.'
  };
  const nome = trim(dados.requesterName);
  const email = trim(dados.requesterEmail);
  if (nome || email) {
    body.requester = {};
    if (nome) body.requester.name = nome;
    if (email) body.requester.email = email;
  }
  if (Array.isArray(dados.tags) && dados.tags.length) body.tags = dados.tags.map(trim).filter(Boolean);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(`${BASE()}/tickets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': KEY(),
        'octa-agent-email': AGENT()
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const txt = await r.text();
    let resp; try { resp = JSON.parse(txt); } catch { resp = { raw: txt.slice(0, 600) }; }
    if (!r.ok) return { ok: false, motivo: `HTTP ${r.status}`, raw: resp };

    const number = resp.number || resp.ticketNumber || resp.id || '';
    return { ok: true, ticketId: String(resp.id || number || ''), number: String(number || ''), url: resp.url || linkTicket(number), raw: resp };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, motivo: e.message };
  }
}

module.exports = { configurado, criarTicket };

// services/octadesk.js — adapter para abrir TICKET no Octadesk a partir de um
// detrator do NPS. ⚠️ AGUARDANDO A DOCUMENTAÇÃO DA API (o usuário vai enviar).
// A estrutura abaixo é o esqueleto; ao chegar a doc, preenche URL/campos/headers.
//
// Env esperadas: OCTADESK_API_URL, OCTADESK_API_TOKEN (e o que a doc pedir).
// Enquanto não configurado, criarTicket() retorna { ok:false, motivo:'nao_configurado' }
// e o endpoint de ação apenas REGISTRA a intenção (sem falhar o fluxo).

const trim = (v) => String(v == null ? '' : v).trim();

function configurado() {
  return !!(trim(process.env.OCTADESK_API_URL) && trim(process.env.OCTADESK_API_TOKEN));
}

// Cria um ticket. `dados` = { nome, email, telefone, assunto, descricao, cliente, pedido, nota }.
// Retorna { ok, ticketId, url, motivo, raw }.
async function criarTicket(dados) {
  if (!configurado()) return { ok: false, motivo: 'nao_configurado' };

  const base = trim(process.env.OCTADESK_API_URL).replace(/\/$/, '');
  const token = trim(process.env.OCTADESK_API_TOKEN);

  // TODO(doc Octadesk): ajustar path, headers e corpo conforme a documentação.
  // Placeholder no formato mais comum (REST + Bearer). NÃO validado ainda.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(`${base}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        subject: dados.assunto || `NPS Detrator — pedido ${dados.pedido || ''}`,
        content: dados.descricao || '',
        requester: { name: dados.nome, email: dados.email, phoneContacts: dados.telefone ? [{ number: dados.telefone }] : [] }
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const txt = await r.text();
    let body; try { body = JSON.parse(txt); } catch { body = { raw: txt.slice(0, 500) }; }
    if (!r.ok) return { ok: false, motivo: `HTTP ${r.status}`, raw: body };
    return { ok: true, ticketId: String(body.id || body.number || ''), url: body.url || '', raw: body };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, motivo: e.message };
  }
}

module.exports = { configurado, criarTicket };

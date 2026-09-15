// services/treinamentos.js — regras compartilhadas do módulo de Treinamentos:
// status de lotação da sessão + efeitos colaterais (calendário M365 + e-mail),
// sempre BEST-EFFORT (nunca quebram a inscrição). Os endpoints ficam finos.

const Email = require('./emailService');
const M365 = require('./m365');

const trim = (v) => String(v == null ? '' : v).trim();
const CALENDAR_ATIVO = () => String(process.env.TREINA_CALENDAR_ATIVO || '') === '1';
const EMAIL_ATIVO = () => String(process.env.TREINA_EMAIL_ATIVO || '1') !== '0';

const fmtDataBR = (v) => {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v || '');
};
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

// Status de lotação de uma sessão (presencial). >0 verde; <=15% amarelo; 0 vermelho.
function statusSessao(sessao, hojeISO) {
  const cap = Number(sessao.capacidade || 0);
  const ocup = Number(sessao.ocupadas || 0);
  const disponiveis = Math.max(0, cap - ocup);
  const dataISO = iso(sessao.data);
  let status;
  if (trim(sessao.status) === 'cancelada') status = 'cancelada';
  else if (hojeISO && dataISO && dataISO < hojeISO) status = 'encerrada';
  else if (disponiveis <= 0) status = 'lotada';
  else if (cap > 0 && disponiveis <= Math.max(1, Math.ceil(cap * 0.15))) status = 'poucas';
  else status = 'disponivel';
  return { status, disponiveis, capacidade: cap, ocupadas: ocup };
}

const linkOnline = (treinamento, sessao) => trim(sessao?.teams_link) || trim(treinamento?.teams_link) || '';
const localSessao = (treinamento, sessao) => trim(sessao?.local) || trim(treinamento?.local_padrao) || '';
const horario = (s) => (s.hora_inicio ? `${trim(s.hora_inicio)}${s.hora_fim ? ' às ' + trim(s.hora_fim) : ''}` : '');

// ---- HTML do e-mail de confirmação (email-safe, inline styles) ----
const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function htmlEvento({ treinamento, sessao, modalidade }) {
  const online = modalidade === 'online';
  const link = linkOnline(treinamento, sessao);
  const linhas = [
    `<b>${esc(treinamento.titulo)}</b>`,
    treinamento.objetivo ? `Objetivo: ${esc(treinamento.objetivo)}` : '',
    `Data: ${fmtDataBR(iso(sessao.data))}${horario(sessao) ? ' — ' + esc(horario(sessao)) : ''}`,
    `Modalidade: ${online ? 'Online' : 'Presencial'}`,
    online ? '' : `Local: ${esc(localSessao(treinamento, sessao)) || '—'}`,
    treinamento.instrutor ? `Instrutor: ${esc(treinamento.instrutor)}` : '',
    treinamento.setor_responsavel ? `Setor responsável: ${esc(treinamento.setor_responsavel)}` : '',
    treinamento.descricao ? `<br>${esc(treinamento.descricao)}` : '',
    (online && link) ? `<br>Link de participação: <a href="${esc(link)}">${esc(link)}</a>` : ''
  ].filter(Boolean);
  return linhas.join('<br>');
}

function emailConfirmacao({ nome, treinamento, sessao, modalidade }) {
  const online = modalidade === 'online';
  const link = linkOnline(treinamento, sessao);
  const subject = `Inscrição confirmada — ${treinamento.titulo}`;
  const row = (k, v) => v ? `<tr><td style="padding:10px 0;color:#64748b;font-size:13px;border-top:1px solid #f1f5f9;">${esc(k)}</td><td style="padding:10px 0;color:#0f172a;font-size:14px;text-align:right;border-top:1px solid #f1f5f9;">${esc(v)}</td></tr>` : '';
  const html = `<!DOCTYPE html><html lang="pt-BR"><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
<tr><td style="background:linear-gradient(135deg,#17457e,#2E86DE);padding:26px 32px;color:#fff;">
<div style="font-size:12px;letter-spacing:1.4px;text-transform:uppercase;opacity:.85;font-weight:600;">Treinamentos · Gnatus</div>
<div style="font-size:22px;font-weight:700;margin-top:4px;">Inscrição confirmada ✅</div></td></tr>
<tr><td style="padding:22px 32px 4px;font-size:15px;line-height:1.6;">Olá, <b>${esc(nome || 'colaborador')}</b>. Sua participação foi registrada com sucesso.</td></tr>
<tr><td style="padding:8px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e2e8f0;">
<tr><td style="padding:10px 0;color:#64748b;font-size:13px;">Treinamento</td><td style="padding:10px 0;color:#0f172a;font-size:14px;font-weight:600;text-align:right;">${esc(treinamento.titulo)}</td></tr>
${row('Data', fmtDataBR(iso(sessao.data)))}
${row('Horário', horario(sessao))}
${row('Modalidade', online ? 'Online' : 'Presencial')}
${row(online ? 'Participação' : 'Local', online ? (link || 'Online (Teams)') : (localSessao(treinamento, sessao) || '—'))}
${row('Instrutor', treinamento.instrutor)}
</table></td></tr>
${(online && link) ? `<tr><td style="padding:16px 32px 0;"><a href="${esc(link)}" style="display:inline-block;background:#17457e;color:#fff;text-decoration:none;border-radius:8px;padding:11px 20px;font-size:14px;font-weight:600;">Entrar no Teams</a></td></tr>` : ''}
<tr><td style="padding:20px 32px 6px;font-size:13px;color:#64748b;line-height:1.6;">O treinamento foi adicionado ao seu calendário corporativo. Em caso de imprevisto, cancele sua inscrição na intranet para liberar a vaga.</td></tr>
<tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:14px 32px;font-size:11px;color:#94a3b8;text-align:center;">Setor Educacional · Gnatus — e-mail automático.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `Inscrição confirmada — ${treinamento.titulo}\nData: ${fmtDataBR(iso(sessao.data))} ${horario(sessao)}\nModalidade: ${online ? 'Online' : 'Presencial'}\n${online ? 'Link: ' + link : 'Local: ' + localSessao(treinamento, sessao)}\n\nSetor Educacional Gnatus`;
  return { subject, html, text };
}

function emailAviso({ nome, treinamento, sessao, tipo }) {
  const map = {
    cancelamento: 'Sua inscrição foi CANCELADA',
    sessao_alterada: 'Houve alteração na sua sessão',
    treinamento_cancelado: 'O treinamento foi CANCELADO'
  };
  const titulo = map[tipo] || 'Atualização da sua inscrição';
  const subject = `${titulo} — ${treinamento.titulo}`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;font-size:15px;line-height:1.6;">
<p>Olá, <b>${esc(nome || 'colaborador')}</b>.</p>
<p>${esc(titulo)} referente ao treinamento <b>${esc(treinamento.titulo)}</b>${sessao ? ` (sessão de ${esc(fmtDataBR(iso(sessao.data)))}${horario(sessao) ? ' — ' + esc(horario(sessao)) : ''})` : ''}.</p>
<p style="color:#64748b;font-size:13px;">Setor Educacional · Gnatus</p></div>`;
  return { subject, html, text: `${titulo} — ${treinamento.titulo}` };
}

// ---- Efeitos best-effort após inscrição (calendário + e-mail) ----
async function efeitosInscricao(app, { inscricao, treinamento, sessao, modalidade, email, nome }) {
  const avisos = [];
  let calendarEventId = null;

  if (CALENDAR_ATIVO() && email) {
    try {
      const ev = await M365.criarEventoCalendario(email, {
        subject: `Treinamento: ${treinamento.titulo}`,
        htmlBody: htmlEvento({ treinamento, sessao, modalidade }),
        data: iso(sessao.data), horaInicio: trim(sessao.hora_inicio), horaFim: trim(sessao.hora_fim),
        local: modalidade === 'online' ? 'Online (Teams)' : localSessao(treinamento, sessao),
        online: modalidade === 'online', teamsLink: linkOnline(treinamento, sessao)
      });
      calendarEventId = ev.id || null;
      if (calendarEventId) {
        await app.services.Pg.connectAndQuery(
          `UPDATE tab_treina_inscricao SET calendar_event_id=@c WHERE id=@id`,
          { c: calendarEventId, id: inscricao.id });
      }
    } catch (e) { avisos.push('calendário: ' + e.message); }
  }

  if (EMAIL_ATIVO() && email) {
    try {
      const { subject, html, text } = emailConfirmacao({ nome, treinamento, sessao, modalidade });
      await Email.sendEmail({ to: email, subject, html, text });
    } catch (e) { avisos.push('e-mail: ' + e.message); }
  }
  return { calendarEventId, avisos };
}

async function removerEventoInscricao(app, { email, calendarEventId }) {
  if (!CALENDAR_ATIVO() || !email || !calendarEventId) return;
  try { await M365.excluirEventoCalendario(email, calendarEventId); } catch (e) { /* best-effort */ }
}

async function avisarPorEmail(email, payload) {
  if (!EMAIL_ATIVO() || !email) return;
  try { const m = emailAviso(payload); await Email.sendEmail({ to: email, ...m }); } catch (e) { /* best-effort */ }
}

module.exports = {
  statusSessao, linkOnline, localSessao, horario, fmtDataBR, iso,
  efeitosInscricao, removerEventoInscricao, avisarPorEmail,
  emailConfirmacao, emailAviso, htmlEvento
};

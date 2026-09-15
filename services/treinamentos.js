// services/treinamentos.js — regras compartilhadas do módulo de Treinamentos:
// status de lotação da sessão + efeitos colaterais (calendário M365 + e-mail),
// sempre BEST-EFFORT (nunca quebram a inscrição). Os endpoints ficam finos.

const crypto = require('crypto');
const Email = require('./emailService');
const M365 = require('./m365');

const trim = (v) => String(v == null ? '' : v).trim();
const CALENDAR_ATIVO = () => String(process.env.TREINA_CALENDAR_ATIVO || '') === '1';
const EMAIL_ATIVO = () => String(process.env.TREINA_EMAIL_ATIVO || '1') !== '0';
// Geração da reunião Teams no calendário do organizador. Herda de CALENDAR_ATIVO
// (mesma permissão Calendars.ReadWrite), mas pode ser ligada isoladamente.
const TEAMS_ATIVO = () => String(process.env.TREINA_TEAMS_ATIVO || '') === '1' || CALENDAR_ATIVO();
const ORGANIZADOR = () => trim(process.env.TREINA_ORGANIZADOR_EMAIL) || 'educacional@gnatus.com.br';
const BASE_URL = () => (process.env.INTRANET_URL || process.env.FRONTEND_URL || 'https://intranew.gnatus.com.br').replace(/\/$/, '');
// Aceita textarea/lista com separadores , ; espaço e quebras de linha → e-mails únicos (lower).
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function parseEmails(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  const out = []; const seen = new Set();
  for (const raw of arr) {
    const e = String(raw || '').trim().toLowerCase();
    if (!e || seen.has(e) || !EMAIL_RX.test(e)) continue;
    seen.add(e); out.push(e);
  }
  return out;
}

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

// ---- (A) Reunião Teams por sessão no calendário do organizador (educacional@) ----
// Garante que a sessão tenha uma reunião Teams criada na agenda do organizador,
// de modo que o link do Teams JÁ EXISTA. Grava educacional_event_id + teams_link
// (joinUrl) na sessão. Best-effort e gated (TEAMS_ATIVO). Devolve o joinUrl ou ''.
// Só faz sentido p/ treinamentos com modalidade online/ambas.
async function garantirReuniaoSessao(app, { treinamento, sessao }) {
  if (!TEAMS_ATIVO()) return { joinUrl: linkOnline(treinamento, sessao), skip: 'gate' };
  const mod = trim(treinamento?.modalidades);
  if (mod === 'presencial') return { joinUrl: '', skip: 'presencial' };
  if (trim(sessao?.status) === 'cancelada') return { joinUrl: trim(sessao.teams_link), skip: 'cancelada' };
  const organizer = ORGANIZADOR();
  try {
    if (trim(sessao.educacional_event_id)) {
      // já existe — só remarca subject/horário (joinUrl é estável); mantém teams_link.
      await M365.atualizarEventoCalendario(organizer, trim(sessao.educacional_event_id), {
        subject: `Treinamento: ${treinamento.titulo}`,
        data: iso(sessao.data), horaInicio: trim(sessao.hora_inicio), horaFim: trim(sessao.hora_fim),
        local: localSessao(treinamento, sessao) || 'Online (Teams)'
      });
      return { joinUrl: trim(sessao.teams_link) };
    }
    const ev = await M365.criarReuniaoTeams(organizer, {
      subject: `Treinamento: ${treinamento.titulo}`,
      htmlBody: htmlEvento({ treinamento, sessao, modalidade: 'online' }),
      data: iso(sessao.data), horaInicio: trim(sessao.hora_inicio), horaFim: trim(sessao.hora_fim),
      local: localSessao(treinamento, sessao) || 'Online (Teams)'
    });
    const joinUrl = trim(ev.joinUrl);
    // Guarda o event_id sempre; teams_link só se veio o joinUrl e a sessão não tem link fixo próprio.
    await app.services.Pg.connectAndQuery(
      `UPDATE tab_treina_sessao
          SET educacional_event_id=@e,
              teams_link = CASE WHEN COALESCE(NULLIF(TRIM(teams_link),''),'')='' AND @j<>'' THEN @j ELSE teams_link END
        WHERE id=@sid`,
      { e: ev.id || null, j: joinUrl, sid: sessao.id });
    return { joinUrl: joinUrl || trim(sessao.teams_link), eventId: ev.id };
  } catch (e) {
    return { joinUrl: linkOnline(treinamento, sessao), erro: e.message };
  }
}

async function excluirReuniaoSessao(app, sessao) {
  if (!TEAMS_ATIVO() || !sessao || !trim(sessao.educacional_event_id)) return;
  try {
    await M365.excluirEventoCalendario(ORGANIZADOR(), trim(sessao.educacional_event_id));
    await app.services.Pg.connectAndQuery(
      `UPDATE tab_treina_sessao SET educacional_event_id=NULL WHERE id=@sid`, { sid: sessao.id });
  } catch (e) { /* best-effort */ }
}

// Token forte (48 hex) p/ links públicos de inscrição.
const novoToken = () => crypto.randomBytes(24).toString('hex');
const linkConvite = (token) => `${BASE_URL()}/convite/${token}`;
const linkPublico = (ptoken) => `${BASE_URL()}/inscricao/${ptoken}`;

// ---- (B) E-mail de convite ao convidado (escolher a data — PÁGINA PÚBLICA, sem login) ----
function emailConvite({ nome, treinamento, sessoes, mensagem, link: linkParam }) {
  const link = linkParam || `${BASE_URL()}/treinamentos`;
  const subject = `Convite: ${treinamento.titulo} — escolha sua data`;
  const linhasSessoes = (sessoes || []).slice(0, 12).map(s => {
    const h = horario(s);
    return `<tr><td style="padding:8px 0;border-top:1px solid #f1f5f9;font-size:14px;color:#0f172a;">📅 ${esc(fmtDataBR(iso(s.data)))}${h ? ' · ' + esc(h) : ''}</td></tr>`;
  }).join('');
  const html = `<!DOCTYPE html><html lang="pt-BR"><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
<tr><td style="background:linear-gradient(135deg,#17457e,#2E86DE);padding:26px 32px;color:#fff;">
<div style="font-size:12px;letter-spacing:1.4px;text-transform:uppercase;opacity:.85;font-weight:600;">Treinamentos · Gnatus</div>
<div style="font-size:22px;font-weight:700;margin-top:4px;">Você foi convidado(a) 🎓</div></td></tr>
<tr><td style="padding:22px 32px 4px;font-size:15px;line-height:1.6;">Olá${nome ? ', <b>' + esc(nome) + '</b>' : ''}. Você foi convidado(a) para o treinamento <b>${esc(treinamento.titulo)}</b>.</td></tr>
${treinamento.objetivo ? `<tr><td style="padding:4px 32px;font-size:14px;color:#475569;line-height:1.6;">${esc(treinamento.objetivo)}</td></tr>` : ''}
${mensagem ? `<tr><td style="padding:8px 32px;"><div style="background:#f8fafc;border-left:3px solid #2E86DE;border-radius:6px;padding:12px 14px;font-size:14px;color:#334155;line-height:1.6;">${esc(mensagem)}</div></td></tr>` : ''}
${linhasSessoes ? `<tr><td style="padding:12px 32px 0;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:.6px;font-weight:600;">Datas disponíveis</td></tr>
<tr><td style="padding:0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${linhasSessoes}</table></td></tr>` : ''}
<tr><td style="padding:22px 32px 6px;font-size:14px;line-height:1.6;color:#334155;">Clique abaixo para <b>escolher a data de participação</b> e garantir sua vaga — <b>não é preciso login</b>:</td></tr>
<tr><td style="padding:8px 32px 4px;"><a href="${esc(link)}" style="display:inline-block;background:#17457e;color:#fff;text-decoration:none;border-radius:8px;padding:12px 22px;font-size:14px;font-weight:600;">Escolher minha data</a></td></tr>
<tr><td style="padding:12px 32px 6px;font-size:12px;color:#94a3b8;line-height:1.6;">Ou copie o endereço: ${esc(link)}<br>Este link é pessoal e intransferível.</td></tr>
<tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:14px 32px;font-size:11px;color:#94a3b8;text-align:center;">Setor Educacional · Gnatus — e-mail automático.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `Convite: ${treinamento.titulo}\n\nVocê foi convidado(a) para este treinamento.${mensagem ? '\n\n' + mensagem : ''}\n\nDatas: ${(sessoes || []).map(s => fmtDataBR(iso(s.data)) + (horario(s) ? ' ' + horario(s) : '')).join('; ')}\n\nEscolha sua data (não é preciso login): ${link}\n\nSetor Educacional Gnatus`;
  return { subject, html, text };
}

async function enviarConvite(app, { treinamento, sessoes, email, nome, mensagem, link }) {
  if (!EMAIL_ATIVO() || !email) return { ok: false, skip: true };
  try {
    // Remetente do convite: por padrão usa o remetente global (Mail.Send comprovado);
    // defina TREINA_CONVITE_REMETENTE=educacional@gnatus.com.br para enviar pelo
    // Educacional DEPOIS que a caixa estiver liberada na Application Access Policy.
    const from = trim(process.env.TREINA_CONVITE_REMETENTE) || undefined;
    const m = emailConvite({ nome, treinamento, sessoes, mensagem, link });
    await Email.sendEmail({ to: email, ...(from ? { from } : {}), ...m });
    return { ok: true };
  } catch (e) { return { ok: false, erro: e.message }; }
}

// View pública (sem login) de um treinamento + sessões com status de lotação.
// NÃO expõe o link do Teams das sessões (revelado só após inscrever + no e-mail).
async function viewPublica(app, treinamentoId) {
  const { Pg } = app.services;
  const tr = await Pg.connectAndQuery(`
    SELECT id, titulo, descricao, objetivo, instrutor, setor_responsavel, local_padrao,
           modalidades, status, permite_cancelamento, permite_troca_sessao
      FROM tab_treina_treinamento WHERE id=@id`, { id: treinamentoId });
  if (!tr.length) return null;
  const t = tr[0];
  const hoje = new Date().toISOString().slice(0, 10);
  const ss = await Pg.connectAndQuery(`
    SELECT id, data, hora_inicio, hora_fim, local, capacidade, ocupadas, status
      FROM tab_treina_sessao WHERE treinamento_id=@id ORDER BY data, hora_inicio`, { id: treinamentoId });
  const sessoes = ss.map(s => {
    const st = statusSessao(s, hoje);
    return {
      id: s.id, data: iso(s.data), horaInicio: trim(s.hora_inicio), horaFim: trim(s.hora_fim),
      local: trim(s.local), capacidade: st.capacidade, disponiveis: st.disponiveis, statusSessao: st.status
    };
  });
  return {
    hoje,
    treinamento: {
      id: t.id, titulo: t.titulo, descricao: t.descricao, objetivo: t.objetivo,
      instrutor: trim(t.instrutor), setorResponsavel: trim(t.setor_responsavel),
      localPadrao: trim(t.local_padrao), modalidades: trim(t.modalidades), status: trim(t.status),
      permiteCancelamento: t.permite_cancelamento !== false, permiteTrocaSessao: t.permite_troca_sessao !== false
    },
    sessoes
  };
}

// ---- Núcleo de inscrição do CONVIDADO (público, sem login) ----
// Amarra a inscrição ao convite (convite_id, colaborador_id NULL). Mantém o mesmo
// controle de vaga à prova de concorrência (CTE atômico). Dedup por convite ativo
// (índice ux_treina_insc_convite_ativa). Retorna { ok, codigo?, inscricaoId, capacidade, ocupadas }.
async function inscreverConvidado(app, { convite, treinamento, sessao, modalidade }) {
  const { Pg } = app.services;
  const tid = Number(treinamento.id);
  const sid = Number(sessao.id);
  const cid = Number(convite.id);
  const nome = trim(convite.nome) || null;
  const email = trim(convite.email) || null;

  if (modalidade === 'presencial') {
    let out;
    try {
      out = await Pg.connectAndQuery(`
        WITH s AS (
          UPDATE tab_treina_sessao SET ocupadas = ocupadas + 1
           WHERE id=@sid AND treinamento_id=@tid AND status='agendada' AND ocupadas < capacidade
          RETURNING id, treinamento_id, capacidade, ocupadas
        ),
        ins AS (
          INSERT INTO tab_treina_inscricao
            (treinamento_id, sessao_id, colaborador_id, colaborador_nome, colaborador_email, modalidade, status, convite_id)
          SELECT treinamento_id, id, NULL, @nome, @email, 'presencial', 'ativa', @cid FROM s
          RETURNING id
        )
        SELECT ins.id inscricao_id, s.capacidade, s.ocupadas FROM ins, s`,
        { sid, tid, nome, email, cid });
    } catch (e) {
      if (e.code === '23505') return { ok: false, codigo: 'JA_INSCRITO' };
      throw e;
    }
    if (!out.length) {
      const chk = await Pg.connectAndQuery(`SELECT capacidade, ocupadas FROM tab_treina_sessao WHERE id=@sid`, { sid });
      const lot = chk[0] && Number(chk[0].ocupadas) >= Number(chk[0].capacidade);
      return { ok: false, codigo: lot ? 'LOTADA' : 'INDISPONIVEL' };
    }
    return { ok: true, inscricaoId: out[0].inscricao_id, capacidade: Number(out[0].capacidade), ocupadas: Number(out[0].ocupadas) };
  }

  // ONLINE — não consome vaga
  let out;
  try {
    out = await Pg.connectAndQuery(`
      INSERT INTO tab_treina_inscricao
        (treinamento_id, sessao_id, colaborador_id, colaborador_nome, colaborador_email, modalidade, status, convite_id)
      SELECT @tid, @sid, NULL, @nome, @email, 'online', 'ativa', @cid
       WHERE EXISTS (SELECT 1 FROM tab_treina_sessao WHERE id=@sid AND treinamento_id=@tid AND status='agendada')
      RETURNING id`, { sid, tid, nome, email, cid });
  } catch (e) {
    if (e.code === '23505') return { ok: false, codigo: 'JA_INSCRITO' };
    throw e;
  }
  if (!out.length) return { ok: false, codigo: 'INDISPONIVEL' };
  return { ok: true, inscricaoId: out[0].id };
}

module.exports = {
  statusSessao, linkOnline, localSessao, horario, fmtDataBR, iso,
  efeitosInscricao, removerEventoInscricao, avisarPorEmail,
  emailConfirmacao, emailAviso, htmlEvento,
  parseEmails, garantirReuniaoSessao, excluirReuniaoSessao,
  emailConvite, enviarConvite, TEAMS_ATIVO, ORGANIZADOR,
  novoToken, linkConvite, linkPublico, inscreverConvidado, viewPublica
};

// services/scNotificacao.js — quando uma SC é criada PELA INTRANET, notifica por
// e-mail os aprovadores pendentes. O Protheus/MATA110 parou de disparar esse
// e-mail (quebrava no caminho da intranet); a intranet assumiu o envio.
//
// Remetente: nfe@gnatus.com.br (.env SC_EMAIL_SENDER). Destinatários = aprovadores
// da SC (SCR010 CR_STATUS='02', ainda não liberada): o aprovador NOMEADO (CR_USER)
// OU os membros do grupo de alçada (SAL010, AL_DOCSC<>'B') — e-mail vindo do SYS_USR.
// Mesma lógica de aprovadores da tela /aprovacoes/pendentes.
//
// Non-fatal: retorna um resumo, nunca lança — a SC já foi criada; se o e-mail
// falhar, só loga (não derruba a criação).

const { sendEmail } = require('./emailService');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const money = (v) => N(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const REMETENTE = () => trim(process.env.SC_EMAIL_SENDER) || 'nfe@gnatus.com.br';
const URL_APROV = 'https://intranew.gnatus.com.br/compras/aprovacoes';

// Lê produto (1º item) + valor total + e-mails dos aprovadores pendentes da SC.
async function dadosSC(Protheus, scNumero) {
  const num = trim(scNumero);

  const itens = await Protheus.connectAndQuery(
    `SELECT RTRIM(C1_ITEM) item, RTRIM(C1_PRODUTO) produto, RTRIM(C1_DESCRI) descricao, C1_TOTAL total
       FROM SC1010 WITH (NOLOCK)
      WHERE D_E_L_E_T_ <> '*' AND C1_FILIAL = '01' AND RTRIM(C1_NUM) = @n
      ORDER BY C1_ITEM`, { n: num });
  const total = itens.reduce((s, x) => s + N(x.total), 0);
  const p0 = itens[0] || {};
  let produto = trim(p0.descricao) || trim(p0.produto) || '(sem produto)';
  if (itens.length > 1) produto += ` (+${itens.length - 1} ${itens.length - 1 === 1 ? 'item' : 'itens'})`;

  // aprovadores: nomeado direto (CR_USER) UNION membros do grupo de alçada (SAL010)
  const aprov = await Protheus.connectAndQuery(
    `SELECT DISTINCT RTRIM(usr.USR_EMAIL) email, RTRIM(usr.USR_NOME) nome
       FROM SCR010 scr WITH (NOLOCK) INNER JOIN SYS_USR usr ON usr.USR_ID = scr.CR_USER
      WHERE scr.D_E_L_E_T_<>'*' AND scr.CR_FILIAL='01' AND scr.CR_TIPO='SC' AND RTRIM(scr.CR_NUM)=@n
        AND scr.CR_STATUS='02' AND RTRIM(ISNULL(scr.CR_LIBAPRO,''))='' AND RTRIM(ISNULL(scr.CR_USER,''))<>''
     UNION
     SELECT DISTINCT RTRIM(usr.USR_EMAIL) email, RTRIM(usr.USR_NOME) nome
       FROM SCR010 scr WITH (NOLOCK)
       INNER JOIN SAL010 sal WITH (NOLOCK)
         ON sal.D_E_L_E_T_<>'*' AND sal.AL_FILIAL='01' AND sal.AL_COD=scr.CR_GRUPO AND RTRIM(sal.AL_DOCSC)<>'B'
       INNER JOIN SYS_USR usr ON usr.USR_ID = sal.AL_USER
      WHERE scr.D_E_L_E_T_<>'*' AND scr.CR_FILIAL='01' AND scr.CR_TIPO='SC' AND RTRIM(scr.CR_NUM)=@n
        AND scr.CR_STATUS='02' AND RTRIM(ISNULL(scr.CR_LIBAPRO,''))='' AND RTRIM(ISNULL(scr.CR_USER,''))=''`,
    { n: num });

  const emails = [...new Set(aprov.map(a => trim(a.email).toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+$/.test(e)))];
  return { num, produto, total, emails, aprovadores: aprov.map(a => trim(a.nome)).filter(Boolean) };
}

function montarEmail({ num, produto, total }) {
  const subject = 'Solicitação de compras aguardando aprovação';
  const text =
    `${subject}\n\n` +
    `Solicitação: ${num}   Produto: ${produto}   Valor total: R$ ${money(total)}.\n\n` +
    `Acesse o Protheus ou Intranew para aprovação.\n${URL_APROV}`;
  const html =
    `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1a2740;max-width:560px">` +
      `<h2 style="color:#1e5fb5;margin:0 0 12px;font-size:1.15rem">Solicitação de compras aguardando aprovação</h2>` +
      `<table style="font-size:15px;line-height:1.7;border-collapse:collapse">` +
        `<tr><td style="color:#8093ac;padding-right:10px">Solicitação:</td><td><b>${num}</b></td></tr>` +
        `<tr><td style="color:#8093ac;padding-right:10px">Produto:</td><td>${produto}</td></tr>` +
        `<tr><td style="color:#8093ac;padding-right:10px">Valor total:</td><td><b>R$ ${money(total)}</b></td></tr>` +
      `</table>` +
      `<p style="margin:16px 0 12px">Acesse o Protheus ou o Intranew para aprovação:</p>` +
      `<p style="margin:0 0 16px"><a href="${URL_APROV}" style="background:#1e5fb5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">Aprovar no Intranew</a></p>` +
      `<p style="font-size:12px;color:#8093ac;margin:0">${URL_APROV}</p>` +
    `</div>`;
  return { subject, text, html };
}

// Notifica os aprovadores da SC recém-criada. Retorna { ok, sc, destinatarios, ... }.
async function notificarAprovadoresSC(app, { scNumero }) {
  const { Protheus } = app.services;
  try {
    const d = await dadosSC(Protheus, scNumero);
    if (!d.emails.length) {
      return { ok: false, motivo: 'SEM_APROVADORES', sc: d.num, destinatarios: [] };
    }
    const msg = montarEmail(d);
    await sendEmail({ from: REMETENTE(), to: d.emails.join(','), subject: msg.subject, text: msg.text, html: msg.html });
    return { ok: true, sc: d.num, produto: d.produto, valor: d.total, destinatarios: d.emails, aprovadores: d.aprovadores };
  } catch (e) {
    console.error(`[scNotificacao] SC ${scNumero}:`, e.message);
    return { ok: false, motivo: 'ERRO', erro: e.message, sc: trim(scNumero), destinatarios: [] };
  }
}

module.exports = { notificarAprovadoresSC, dadosSC, montarEmail };

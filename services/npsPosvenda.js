// services/npsPosvenda.js — núcleo da Pesquisa de Pós-venda (NPS).
// Classificação, leitura de config, geração de token e disparo do link por
// WhatsApp (Suri). O disparo do link usa um template Suri gated por env
// (SURI_TPL_NPS): enquanto vazio, o convite fica ENVIADO=false com aviso.

const crypto = require('crypto');
const Suri = require('./suri');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

// Base pública da pesquisa (onde a página pública é servida). Ex.:
// https://intranew.gnatus.com.br/pesquisa/<token>
const BASE_PUBLICA = () => (process.env.NPS_BASE_URL || 'https://intranew.gnatus.com.br').replace(/\/$/, '');
const linkPesquisa = (token) => `${BASE_PUBLICA()}/pesquisa/${token}`;

// Template Suri (aprovado no Meta) do convite. Params: [nome, link].
const TPL_NPS = () => trim(process.env.SURI_TPL_NPS);

// Caixa remetente do e-mail da pesquisa (canal secundário do CX). Fixa em
// cx@gnatus.com.br para o cliente reconhecer e responder na caixa certa. ⚠️ a App
// Registration do Graph precisa ter a Application Access Policy liberando ESTA
// caixa (senão o sendMail retorna 403), além da caixa global e da cobranca@.
const SENDER_CX = () => trim(process.env.EMAIL_SENDER_CX) || 'cx@gnatus.com.br';

function gerarToken() {
  return crypto.randomBytes(18).toString('base64url');   // ~24 chars url-safe
}

// Lê toda a config (chave->valor) num objeto.
async function lerConfig(Pg) {
  const rows = await Pg.connectAndQuery(`SELECT chave, valor FROM tab_nps_config`, {});
  const cfg = {};
  rows.forEach((r) => { cfg[r.chave] = r.valor; });
  return {
    detratorMax: N(cfg.classificacao?.detratorMax ?? 6),
    promotorMin: N(cfg.classificacao?.promotorMin ?? 9),
    ativo: cfg.ativo === true || cfg.ativo === 'true',
    dataInicio: cfg.dataInicio || null,   // 'YYYY-MM-DD' ou null — piso do faturamento (obrigatorio)
    dataFim: cfg.dataFim || null,         // 'YYYY-MM-DD' ou null — teto do faturamento (opcional; vazio = sem limite)
    expiraDias: N(cfg.expiraDias ?? 30),
    lembreteDias: N(cfg.lembreteDias ?? 3),
    antifadigaDias: N(cfg.antifadigaDias ?? 30),
    criticoMax: N(cfg.criticoMax ?? 3),
    alertaEmails: Array.isArray(cfg.alertaEmails) ? cfg.alertaEmails : [],
    mensagem: cfg.mensagem || {}
  };
}

// Classifica a nota NPS (0-10) conforme os thresholds configurados.
function classificar(nota, cfg) {
  const n = N(nota);
  if (n <= cfg.detratorMax) return 'DETRATOR';
  if (n >= cfg.promotorMin) return 'PROMOTOR';
  return 'NEUTRO';
}

// Classifica a partir da PERGUNTA classificadora (e_nps) e da resposta dada:
//   - tipo 'opcao' (CSAT): usa class_map[opção] -> PROMOTOR|NEUTRO|DETRATOR;
//     a "nota" vira um ordinal (1ª opção = maior) só p/ média/gráficos.
//   - tipo 'nps'/'escala': usa a nota + thresholds.
// pNps = { tipo, opcoes[], class_map{} }. resp = { nota, opcao }.
// Retorna { classificacao, notaNps }.
function classificarResposta(pNps, resp, cfg) {
  if (!pNps || !resp) return { classificacao: null, notaNps: null };
  const tipo = trim(pNps.tipo);
  if (tipo === 'opcao') {
    const opc = trim(resp.opcao);
    if (!opc) return { classificacao: null, notaNps: null };
    const cmap = pNps.class_map || {};
    const cls = trim(cmap[opc]).toUpperCase();
    const opts = Array.isArray(pNps.opcoes) ? pNps.opcoes : [];
    const idx = opts.indexOf(opc);
    const notaNps = idx >= 0 ? (opts.length - idx) : null;   // 1ª opção = maior nota
    return { classificacao: ['PROMOTOR', 'NEUTRO', 'DETRATOR'].includes(cls) ? cls : null, notaNps };
  }
  if (resp.nota == null || resp.nota === '') return { classificacao: null, notaNps: null };
  const nota = N(resp.nota);
  return { classificacao: classificar(nota, cfg), notaNps: nota };
}

// Monta o telefone bruto a partir dos campos da SA1. A1_TEL = número; DDD vem de
// A1_DDD (fallback A1_DDDCEL, que na base guarda só o DDD). Strip de zero à
// esquerda no DDD ("027"->"27"). Se A1_TEL já vier com DDD embutido, o
// normalizePhone da Suri rejeita o excesso — por isso priorizamos DDD+número.
function montarTelefone(ddd, dddcel, tel) {
  const soDig = (s) => String(s || '').replace(/\D/g, '');
  const d = (soDig(ddd) || soDig(dddcel)).replace(/^0+/, '');
  const n = soDig(tel);
  return n ? (d + n) : '';
}

// Dispara o link da pesquisa por WhatsApp (Suri). Retorna { ok, motivo, raw }.
async function dispararWhatsapp({ telefone, nome, token }) {
  const tpl = TPL_NPS();
  if (!tpl) return { ok: false, motivo: 'template_nao_configurado' };
  const phone = Suri.normalizePhone(telefone);
  if (!phone) return { ok: false, motivo: 'telefone_invalido' };
  try {
    const resp = await Suri.enviarTemplateId({
      phone, templateId: tpl,
      parameters: [trim(nome) || 'Cliente', linkPesquisa(token)]
    });
    return { ok: resp.ok === true, motivo: resp.ok ? 'enviado' : (resp.erro || 'falha_suri'), raw: resp.raw };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}

// Escapa texto para interpolar com segurança dentro do HTML do e-mail (nome/empresa
// vêm do cadastro; sem isto um "&" ou "<" no nome quebraria a marcação).
const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Monta o e-mail (assunto + HTML + texto) do convite da pesquisa. Layout seguro
// para clientes de e-mail: tabelas + estilos inline, largura 600, botão
// "bulletproof" (com fallback VML pro Outlook desktop). Identidade visual da
// marca (mesma paleta da página pública /pesquisa): navy #0f2f57, azul #1e5fb5,
// verde CTA #1e7d4f. Retorna { subject, html, text }.
function montarEmailConvite({ nome, empresa, link }) {
  const primeiro = trim(nome).split(/\s+/)[0] || 'Cliente';
  const saud = escHtml(primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase());
  const emp = escHtml(trim(empresa));
  const href = escHtml(trim(link));

  const subject = `${saud}, sua opinião é muito importante para a Gnatus 💙`;

  const text =
`Olá, ${primeiro}!

Obrigado por escolher a Gnatus. Sua opinião nos ajuda a evoluir sempre.
Poderia responder nossa pesquisa rápida? Leva menos de 1 minuto:

${trim(link)}

Um abraço,
Equipe de Experiência do Cliente — Gnatus`;

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta name="x-apple-disable-message-reformatting"/>
<title>Pesquisa de satisfação Gnatus</title>
<!--[if mso]><style>table,td,div,a{font-family:Arial,sans-serif !important}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:#eef2f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Leva menos de 1 minuto — conte pra gente como foi sua experiência.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(15,47,87,.12);">
      <!-- header -->
      <tr><td align="center" style="background:#0f2f57;padding:28px 24px;">
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:30px;font-weight:900;letter-spacing:3px;color:#ffffff;">GNATUS</div>
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;letter-spacing:1px;color:#9fc0ec;margin-top:4px;text-transform:uppercase;">Pesquisa de satisfação</div>
      </td></tr>
      <!-- corpo -->
      <tr><td style="padding:34px 34px 8px 34px;font-family:Segoe UI,Arial,sans-serif;color:#1a2740;">
        <div style="font-size:20px;font-weight:800;color:#1a2740;">Olá, ${saud}! 👋</div>
        <p style="font-size:15px;line-height:1.6;color:#3d4a5c;margin:14px 0 0 0;">
          Obrigado por escolher a Gnatus${emp ? ` e por confiar na <b>${emp}</b>` : ''}. Queremos muito saber como foi a sua experiência.
        </p>
        <p style="font-size:15px;line-height:1.6;color:#3d4a5c;margin:12px 0 0 0;">
          É bem rapidinho — <b>leva menos de 1 minuto</b> — e a sua resposta nos ajuda a evoluir sempre. 💙
        </p>
      </td></tr>
      <!-- botao bulletproof -->
      <tr><td align="center" style="padding:26px 34px 6px 34px;">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:52px;v-text-anchor:middle;width:280px;" arcsize="24%" strokecolor="#1e7d4f" fillcolor="#1e7d4f">
          <w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">Responder pesquisa</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-->
        <a href="${href}" target="_blank" style="display:inline-block;background:#1e7d4f;color:#ffffff;font-family:Segoe UI,Arial,sans-serif;font-size:16px;font-weight:800;text-decoration:none;padding:15px 40px;border-radius:12px;">Responder pesquisa</a>
        <!--<![endif]-->
      </td></tr>
      <!-- link fallback -->
      <tr><td align="center" style="padding:6px 34px 30px 34px;font-family:Segoe UI,Arial,sans-serif;">
        <div style="font-size:12px;color:#8093ac;">Se o botão não funcionar, copie e cole este endereço no navegador:</div>
        <div style="font-size:12px;margin-top:4px;"><a href="${href}" target="_blank" style="color:#1e5fb5;word-break:break-all;">${href}</a></div>
      </td></tr>
      <!-- rodape -->
      <tr><td style="background:#f4f7fb;padding:22px 34px;font-family:Segoe UI,Arial,sans-serif;border-top:1px solid #e3e9f2;">
        <div style="font-size:13px;color:#5a6b82;">Um abraço,<br/><b style="color:#1a2740;">Equipe de Experiência do Cliente</b> · Gnatus</div>
        <div style="font-size:11px;color:#9aa7b8;margin-top:12px;line-height:1.5;">
          Você recebeu este e-mail porque realizou uma compra recente com a Gnatus. Este é um contato pontual de pesquisa de satisfação.
        </div>
      </td></tr>
    </table>
    <div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#9aa7b8;margin-top:14px;">Gnatus · Pesquisa de satisfação</div>
  </td></tr>
</table>
</body>
</html>`;

  return { subject, html, text };
}

// Dispara o link da pesquisa por E-MAIL (canal secundário, tratativa do CX).
// Remetente = cx@gnatus.com.br. Resolve o e-mail de destino nesta ordem:
// override informado > e-mail vivo da SA1 do cliente do convite. Registra
// email_enviado_em/email_destino e, se o convite estava em ERRO (WhatsApp
// falhou), promove para ENVIADO — agora foi entregue por outro canal.
// Retorna { ok, email, motivo }.
async function dispararEmail(app, { conviteId, emailOverride }) {
  const { Pg, Protheus } = app.services;
  const rows = await Pg.connectAndQuery(
    `SELECT id, token, cliente_nome, empresa, cliente_cod, cliente_loja, status
       FROM tab_nps_convite WHERE id=@id`, { id: conviteId });
  if (!rows.length) return { ok: false, motivo: 'convite_nao_encontrado' };
  const c = rows[0];

  // e-mail de destino: override do CX > e-mail vivo da SA1
  let email = trim(emailOverride);
  if (!email && Protheus && trim(c.cliente_cod)) {
    try {
      const sa1 = await Protheus.connectAndQuery(
        `SELECT RTRIM(A1_EMAIL) EMAIL FROM SA1010 WITH (NOLOCK)
          WHERE D_E_L_E_T_<>'*' AND RTRIM(A1_COD)=@cod AND RTRIM(A1_LOJA)=@loja`,
        { cod: trim(c.cliente_cod), loja: trim(c.cliente_loja) });
      email = trim(sa1[0]?.EMAIL);
    } catch (e) { console.warn('[nps] email SA1:', e.message); }
  }
  // pega só o 1o e-mail se a SA1 trouxer vários (separados por ; ou ,)
  email = email.split(/[;,\s]+/).map((s) => s.trim()).filter(Boolean)[0] || '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, motivo: 'email_invalido', email };

  const { subject, html, text } = montarEmailConvite({
    nome: c.cliente_nome, empresa: c.empresa, link: linkPesquisa(c.token)
  });

  try {
    const emailService = require('./emailService');
    await emailService.sendEmail({ from: SENDER_CX(), to: email, subject, html, text });
  } catch (e) {
    console.error('[nps] dispararEmail:', e.message);
    return { ok: false, motivo: e.message, email };
  }

  await Pg.connectAndQuery(
    `UPDATE tab_nps_convite
        SET email_enviado_em=NOW(), email_destino=@email,
            status = CASE WHEN status='ERRO' THEN 'ENVIADO' ELSE status END,
            enviado_em = COALESCE(enviado_em, NOW())
      WHERE id=@id`, { id: conviteId, email });
  return { ok: true, email };
}

// Poll do scheduler: acha pedidos que chegaram a estatus 99 (TOTALMENTE
// FATURADO) faturados a partir de config.dataInicio, cria o convite (dedupe por
// filial+pedido) e dispara o link por WhatsApp. Só roda com o módulo ATIVO e o
// template Suri configurado (senão criaria convites que não podem ser enviados).
async function processarFaturados(app) {
  const { Pg, Protheus } = app.services;
  const cfg = await lerConfig(Pg);
  if (!cfg.ativo) return { skipped: 'inativo' };
  if (!TPL_NPS()) return { skipped: 'sem_template_suri' };
  if (!cfg.dataInicio) return { skipped: 'sem_dataInicio' };

  const dini = String(cfg.dataInicio).replace(/-/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(dini)) return { skipped: 'dataInicio_invalida' };

  // Teto opcional (data limite). Vazio/invalido = sem limite superior (nao aborta:
  // ao contrario do piso, o teto nao e obrigatorio). Inclusivo do proprio dia.
  const dfimRaw = cfg.dataFim ? String(cfg.dataFim).replace(/-/g, '').slice(0, 8) : '';
  const dfim = /^\d{8}$/.test(dfimRaw) ? dfimRaw : '';
  const filtroDataFim = dfim ? 'AND D2_EMISSAO <= @dfim' : '';

  // Candidatos: NF de saída (SD2) emitida a partir de dini, cujo pedido está
  // totalmente faturado (MAX estatus = 99). Driven pela SD2 recente (bounded).
  let cand;
  try {
    cand = await Protheus.connectAndQuery(`
      SELECT TOP 200
             RTRIM(sc5.C5_NUM) pedido, RTRIM(sc5.C5_CLIENTE) cod, RTRIM(sc5.C5_LOJACLI) loja,
             RTRIM(sa1.A1_NOME) nome, RTRIM(sa1.A1_NREDUZ) empresa, RTRIM(sa1.A1_CGC) cgc,
             RTRIM(sa1.A1_DDDCEL) dddcel, RTRIM(sa1.A1_DDD) ddd, RTRIM(sa1.A1_TEL) tel,
             nf.dataFat, nf.nf, CAST(ISNULL(tp.total,0) AS NUMERIC(15,2)) valor,
             RTRIM(sc5.C5_ZTIPO) buCod, RTRIM(x5.X5_DESCRI) buNome,
             RTRIM(sc5.C5_VEND1) vendCod, RTRIM(sa3.A3_NOME) vendNome,
             RTRIM(sc5.C5_TRANSP) transpCod, RTRIM(sa4.A4_NOME) transpNome,
             RTRIM(lin.grupo) linhaCod, RTRIM(lin.grupoDesc) linhaDesc,
             RTRIM(prod.prodCod) prodCod, RTRIM(prod.prodDesc) prodDesc
        FROM (SELECT D2_PEDIDO ped, MAX(D2_EMISSAO) dataFat, MAX(RTRIM(D2_DOC)) nf
                FROM SD2010 WITH (NOLOCK)
               WHERE D_E_L_E_T_ <> '*' AND D2_FILIAL = '01' AND D2_EMISSAO >= @dini ${filtroDataFim} AND RTRIM(D2_PEDIDO) <> ''
               GROUP BY D2_PEDIDO) nf
        JOIN SC5010 sc5 WITH (NOLOCK) ON sc5.C5_FILIAL = '01' AND RTRIM(sc5.C5_NUM) = nf.ped AND sc5.D_E_L_E_T_ <> '*'
                                     AND RTRIM(sc5.C5_ZTIPO) = 'COV'   -- pesquisa NPS só para Comercial Varejo (BU COV)
        JOIN (SELECT c6_num, MAX(estatus_cod) mx FROM pedidos_estatus WITH (NOLOCK) WHERE c6_filial = '01' GROUP BY c6_num) pe
          ON pe.c6_num = sc5.C5_NUM AND pe.mx = 99
        LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = sc5.C5_CLIENTE AND sa1.A1_LOJA = sc5.C5_LOJACLI AND sa1.D_E_L_E_T_ <> '*'
        LEFT JOIN total_pedido_sc6 tp WITH (NOLOCK) ON tp.c6_num = sc5.C5_NUM
        LEFT JOIN SX5010 x5 WITH (NOLOCK) ON RTRIM(x5.X5_TABELA)='Z1' AND RTRIM(x5.X5_CHAVE)=RTRIM(sc5.C5_ZTIPO) AND x5.D_E_L_E_T_<>'*'
        LEFT JOIN SA3010 sa3 WITH (NOLOCK) ON sa3.A3_COD = sc5.C5_VEND1 AND sa3.D_E_L_E_T_<>'*'
        LEFT JOIN SA4010 sa4 WITH (NOLOCK) ON sa4.A4_COD = sc5.C5_TRANSP AND sa4.D_E_L_E_T_<>'*'
        OUTER APPLY (SELECT TOP 1 sb1.B1_GRUPO grupo, RTRIM(bm.BM_DESC) grupoDesc
                       FROM SC6010 c6 WITH (NOLOCK)
                       JOIN SB1010 sb1 WITH (NOLOCK) ON sb1.B1_COD=c6.C6_PRODUTO AND sb1.D_E_L_E_T_<>'*'
                       LEFT JOIN SBM010 bm WITH (NOLOCK) ON bm.BM_GRUPO=sb1.B1_GRUPO AND bm.D_E_L_E_T_<>'*'
                      WHERE c6.C6_FILIAL='01' AND RTRIM(c6.C6_NUM)=RTRIM(sc5.C5_NUM) AND c6.D_E_L_E_T_<>'*'
                      GROUP BY sb1.B1_GRUPO, bm.BM_DESC
                      ORDER BY SUM(c6.C6_VALOR) DESC) lin
        OUTER APPLY (SELECT TOP 1 RTRIM(c6.C6_PRODUTO) prodCod, RTRIM(c6.C6_DESCRI) prodDesc
                       FROM SC6010 c6 WITH (NOLOCK)
                      WHERE c6.C6_FILIAL='01' AND RTRIM(c6.C6_NUM)=RTRIM(sc5.C5_NUM) AND c6.D_E_L_E_T_<>'*'
                      ORDER BY c6.C6_VALOR DESC) prod
       ORDER BY nf.dataFat DESC`, dfim ? { dini, dfim } : { dini });
  } catch (e) {
    console.error('[nps] falha ao buscar faturados:', e.message);
    return { erro: e.message };
  }

  let criados = 0, enviados = 0, semTelefone = 0, jaExistiam = 0, falhas = 0, antifadiga = 0;
  for (const r of cand) {
    const pedido = trim(r.pedido);

    // anti-fadiga: não pesquisa o mesmo cliente mais de 1x na janela configurada
    if (cfg.antifadigaDias > 0 && trim(r.cod)) {
      const recente = await Pg.connectAndQuery(
        `SELECT 1 FROM tab_nps_convite
          WHERE cliente_cod=@cod AND cliente_loja=@loja
            AND criado_em >= NOW() - (@dias || ' days')::interval LIMIT 1`,
        { cod: trim(r.cod), loja: trim(r.loja), dias: String(cfg.antifadigaDias) });
      if (recente.length) { antifadiga++; continue; }
    }

    const token = gerarToken();
    let ins;
    try {
      ins = await Pg.connectAndQuery(`
        INSERT INTO tab_nps_convite (token, pedido, filial, cliente_cod, cliente_loja, cliente_nome, empresa, cnpj, telefone, nf, valor_pedido,
                                     bu_cod, bu_nome, vendedor_cod, vendedor_nome, transportadora_cod, transportadora_nome, linha_cod, linha_desc,
                                     produto_cod, produto_desc, data_faturamento,
                                     status, expira_em)
        VALUES (@token, @pedido, '01', @cod, @loja, @nome, @empresa, @cnpj, @tel, @nf, @valor,
                @buCod, @buNome, @vendCod, @vendNome, @transpCod, @transpNome, @linhaCod, @linhaDesc,
                @prodCod, @prodDesc, @dataFat,
                'PENDENTE', NOW() + (@dias || ' days')::interval)
        ON CONFLICT (filial, pedido) DO NOTHING
        RETURNING id`,
        {
          token, pedido, cod: trim(r.cod), loja: trim(r.loja), nome: trim(r.nome), empresa: trim(r.empresa) || null, cnpj: trim(r.cgc),
          tel: null, nf: trim(r.nf), valor: N(r.valor),
          buCod: trim(r.buCod), buNome: trim(r.buNome), vendCod: trim(r.vendCod), vendNome: trim(r.vendNome),
          transpCod: trim(r.transpCod), transpNome: trim(r.transpNome), linhaCod: trim(r.linhaCod), linhaDesc: trim(r.linhaDesc),
          prodCod: trim(r.prodCod) || null, prodDesc: trim(r.prodDesc) || null, dataFat: trim(r.dataFat) || null,
          dias: String(cfg.expiraDias)
        });
    } catch (e) { console.warn('[nps] insert convite:', e.message); falhas++; continue; }
    if (!ins.length) { jaExistiam++; continue; }   // dedupe
    criados++;
    const conviteId = ins[0].id;

    // telefone (SA1). ⚠️ A1_DDDCEL guarda SÓ o DDD do celular (ex.: "81"), NÃO o
    // número — nunca usar sozinho. O número vem de A1_TEL; o DDD de A1_DDD (com
    // fallback A1_DDDCEL). Ambos podem ter zero à esquerda ("027") → normaliza.
    const brutoTel = montarTelefone(r.ddd, r.dddcel, r.tel);
    const disp = await dispararWhatsapp({ telefone: brutoTel, nome: trim(r.nome), token });

    if (disp.ok) {
      enviados++;
      await Pg.connectAndQuery(
        `UPDATE tab_nps_convite SET status='ENVIADO', telefone=@tel, enviado_em=NOW(), envio_resposta=@r::jsonb WHERE id=@id`,
        { tel: Suri.normalizePhone(brutoTel), r: JSON.stringify(disp.raw || { motivo: disp.motivo }), id: conviteId });
    } else {
      if (disp.motivo === 'telefone_invalido') semTelefone++; else falhas++;
      await Pg.connectAndQuery(
        `UPDATE tab_nps_convite SET status='ERRO', telefone=@tel, envio_resposta=@r::jsonb WHERE id=@id`,
        { tel: Suri.normalizePhone(brutoTel), r: JSON.stringify({ motivo: disp.motivo }), id: conviteId });
    }
  }

  return { candidatos: cand.length, criados, enviados, semTelefone, jaExistiam, antifadiga, falhas };
}

// Lembrete D+X: reenvia o link p/ quem foi ENVIADO, não respondeu, passou o
// prazo de lembrete e ainda não expirou. 1 lembrete por convite (lembrete_em).
async function processarLembretes(app) {
  const { Pg } = app.services;
  const cfg = await lerConfig(Pg);
  if (!cfg.ativo || !TPL_NPS() || cfg.lembreteDias <= 0) return { skipped: true };

  const pend = await Pg.connectAndQuery(`
    SELECT id, token, cliente_nome, telefone FROM tab_nps_convite
     WHERE status='ENVIADO' AND lembrete_em IS NULL
       AND enviado_em <= NOW() - (@dias || ' days')::interval
       AND (expira_em IS NULL OR expira_em > NOW())
       AND telefone IS NOT NULL AND telefone <> ''
     ORDER BY enviado_em LIMIT 100`, { dias: String(cfg.lembreteDias) });

  let enviados = 0, falhas = 0;
  for (const c of pend) {
    const disp = await dispararWhatsapp({ telefone: c.telefone, nome: trim(c.cliente_nome), token: c.token });
    await Pg.connectAndQuery(`UPDATE tab_nps_convite SET lembrete_em=NOW() WHERE id=@id`, { id: c.id });
    if (disp.ok) enviados++; else falhas++;
  }
  return { lembretes: pend.length, enviados, falhas };
}

// Alerta em tempo real quando entra um DETRATOR CRÍTICO (nota <= criticoMax).
// E-mail para a lista tab_nps_config.alertaEmails. Fire-and-forget (não bloqueia
// a resposta do cliente). Chamado pelo endpoint público após classificar.
async function alertarDetratorCritico(app, conviteId) {
  try {
    const { Pg } = app.services;
    const cfg = await lerConfig(Pg);
    if (!cfg.alertaEmails.length) return;

    const rows = await Pg.connectAndQuery(`
      SELECT c.pedido, c.cliente_nome, c.cliente_cod, c.cliente_loja, c.telefone, c.nota_nps,
             c.bu_nome, c.vendedor_nome, c.transportadora_nome, c.linha_desc,
             (SELECT texto FROM tab_nps_resposta r WHERE r.convite_id=c.id AND r.texto IS NOT NULL AND r.texto<>'' ORDER BY r.id LIMIT 1) motivo
        FROM tab_nps_convite c WHERE c.id=@id`, { id: conviteId });
    if (!rows.length) return;
    const d = rows[0];
    if (d.nota_nps == null || N(d.nota_nps) > cfg.criticoMax) return;

    const emailService = require('./emailService');
    const html = `
      <div style="font-family:system-ui,Arial,sans-serif;color:#1a2740">
        <h2 style="color:#c0392b;margin:0 0 8px">⚠️ Detrator crítico no NPS (nota ${d.nota_nps})</h2>
        <p>Um cliente avaliou a Gnatus com nota <b>${d.nota_nps}</b> na pesquisa de pós-venda. Recomenda-se contato imediato.</p>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:3px 10px;color:#6b7a90">Cliente</td><td style="padding:3px 10px"><b>${trim(d.cliente_nome)}</b> (${trim(d.cliente_cod)}/${trim(d.cliente_loja)})</td></tr>
          <tr><td style="padding:3px 10px;color:#6b7a90">Pedido</td><td style="padding:3px 10px">${trim(d.pedido)}</td></tr>
          <tr><td style="padding:3px 10px;color:#6b7a90">Telefone</td><td style="padding:3px 10px">${trim(d.telefone) || '—'}</td></tr>
          <tr><td style="padding:3px 10px;color:#6b7a90">BU / Vendedor</td><td style="padding:3px 10px">${trim(d.bu_nome) || '—'} / ${trim(d.vendedor_nome) || '—'}</td></tr>
          <tr><td style="padding:3px 10px;color:#6b7a90">Transportadora / Linha</td><td style="padding:3px 10px">${trim(d.transportadora_nome) || '—'} / ${trim(d.linha_desc) || '—'}</td></tr>
          <tr><td style="padding:3px 10px;color:#6b7a90;vertical-align:top">Motivo informado</td><td style="padding:3px 10px">${trim(d.motivo) || '<i>não informado</i>'}</td></tr>
        </table>
        <p style="margin-top:12px"><a href="${BASE_PUBLICA()}/sac/nps" style="background:#1e5fb5;color:#fff;padding:8px 16px;border-radius:8px;text-decoration:none">Abrir painel de Detratores</a></p>
      </div>`;
    await emailService.sendEmail({
      to: cfg.alertaEmails,
      subject: `⚠️ NPS: detrator crítico (nota ${d.nota_nps}) — ${trim(d.cliente_nome)} · pedido ${trim(d.pedido)}`,
      html
    });
  } catch (e) {
    console.warn('[nps] alerta detrator critico:', e.message);
  }
}

module.exports = { gerarToken, lerConfig, classificar, classificarResposta, dispararWhatsapp, dispararEmail, montarEmailConvite, montarTelefone, linkPesquisa, BASE_PUBLICA, TPL_NPS, SENDER_CX, processarFaturados, processarLembretes, alertarDetratorCritico };

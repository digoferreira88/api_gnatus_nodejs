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
    dataInicio: cfg.dataInicio || null,   // 'YYYY-MM-DD' ou null
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

  // Candidatos: NF de saída (SD2) emitida a partir de dini, cujo pedido está
  // totalmente faturado (MAX estatus = 99). Driven pela SD2 recente (bounded).
  let cand;
  try {
    cand = await Protheus.connectAndQuery(`
      SELECT TOP 200
             RTRIM(sc5.C5_NUM) pedido, RTRIM(sc5.C5_CLIENTE) cod, RTRIM(sc5.C5_LOJACLI) loja,
             RTRIM(sa1.A1_NOME) nome, RTRIM(sa1.A1_CGC) cgc,
             RTRIM(sa1.A1_DDDCEL) dddcel, RTRIM(sa1.A1_DDD) ddd, RTRIM(sa1.A1_TEL) tel,
             nf.dataFat, nf.nf, CAST(ISNULL(tp.total,0) AS NUMERIC(15,2)) valor,
             RTRIM(sc5.C5_ZTIPO) buCod, RTRIM(x5.X5_DESCRI) buNome,
             RTRIM(sc5.C5_VEND1) vendCod, RTRIM(sa3.A3_NOME) vendNome,
             RTRIM(sc5.C5_TRANSP) transpCod, RTRIM(sa4.A4_NOME) transpNome,
             RTRIM(lin.grupo) linhaCod, RTRIM(lin.grupoDesc) linhaDesc
        FROM (SELECT D2_PEDIDO ped, MAX(D2_EMISSAO) dataFat, MAX(RTRIM(D2_DOC)) nf
                FROM SD2010 WITH (NOLOCK)
               WHERE D_E_L_E_T_ <> '*' AND D2_FILIAL = '01' AND D2_EMISSAO >= @dini AND RTRIM(D2_PEDIDO) <> ''
               GROUP BY D2_PEDIDO) nf
        JOIN SC5010 sc5 WITH (NOLOCK) ON sc5.C5_FILIAL = '01' AND RTRIM(sc5.C5_NUM) = nf.ped AND sc5.D_E_L_E_T_ <> '*'
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
       ORDER BY nf.dataFat DESC`, { dini });
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
        INSERT INTO tab_nps_convite (token, pedido, filial, cliente_cod, cliente_loja, cliente_nome, cnpj, telefone, nf, valor_pedido,
                                     bu_cod, bu_nome, vendedor_cod, vendedor_nome, transportadora_cod, transportadora_nome, linha_cod, linha_desc,
                                     status, expira_em)
        VALUES (@token, @pedido, '01', @cod, @loja, @nome, @cnpj, @tel, @nf, @valor,
                @buCod, @buNome, @vendCod, @vendNome, @transpCod, @transpNome, @linhaCod, @linhaDesc,
                'PENDENTE', NOW() + (@dias || ' days')::interval)
        ON CONFLICT (filial, pedido) DO NOTHING
        RETURNING id`,
        {
          token, pedido, cod: trim(r.cod), loja: trim(r.loja), nome: trim(r.nome), cnpj: trim(r.cgc),
          tel: null, nf: trim(r.nf), valor: N(r.valor),
          buCod: trim(r.buCod), buNome: trim(r.buNome), vendCod: trim(r.vendCod), vendNome: trim(r.vendNome),
          transpCod: trim(r.transpCod), transpNome: trim(r.transpNome), linhaCod: trim(r.linhaCod), linhaDesc: trim(r.linhaDesc),
          dias: String(cfg.expiraDias)
        });
    } catch (e) { console.warn('[nps] insert convite:', e.message); falhas++; continue; }
    if (!ins.length) { jaExistiam++; continue; }   // dedupe
    criados++;
    const conviteId = ins[0].id;

    // telefone (SA1: celular preferido)
    const dddcel = String(r.dddcel || '').replace(/\D/g, '').replace(/^0+/, '');
    const brutoTel = dddcel || (String(r.ddd || '').replace(/\D/g, '') + String(r.tel || '').replace(/\D/g, ''));
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

module.exports = { gerarToken, lerConfig, classificar, dispararWhatsapp, linkPesquisa, BASE_PUBLICA, TPL_NPS, processarFaturados, processarLembretes, alertarDetratorCritico };

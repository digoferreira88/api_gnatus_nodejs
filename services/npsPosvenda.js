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
             nf.dataFat, nf.nf, CAST(ISNULL(tp.total,0) AS NUMERIC(15,2)) valor
        FROM (SELECT D2_PEDIDO ped, MAX(D2_EMISSAO) dataFat, MAX(RTRIM(D2_DOC)) nf
                FROM SD2010 WITH (NOLOCK)
               WHERE D_E_L_E_T_ <> '*' AND D2_FILIAL = '01' AND D2_EMISSAO >= @dini AND RTRIM(D2_PEDIDO) <> ''
               GROUP BY D2_PEDIDO) nf
        JOIN SC5010 sc5 WITH (NOLOCK) ON sc5.C5_FILIAL = '01' AND RTRIM(sc5.C5_NUM) = nf.ped AND sc5.D_E_L_E_T_ <> '*'
        JOIN (SELECT c6_num, MAX(estatus_cod) mx FROM pedidos_estatus WITH (NOLOCK) WHERE c6_filial = '01' GROUP BY c6_num) pe
          ON pe.c6_num = sc5.C5_NUM AND pe.mx = 99
        LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = sc5.C5_CLIENTE AND sa1.A1_LOJA = sc5.C5_LOJACLI AND sa1.D_E_L_E_T_ <> '*'
        LEFT JOIN total_pedido_sc6 tp WITH (NOLOCK) ON tp.c6_num = sc5.C5_NUM
       ORDER BY nf.dataFat DESC`, { dini });
  } catch (e) {
    console.error('[nps] falha ao buscar faturados:', e.message);
    return { erro: e.message };
  }

  let criados = 0, enviados = 0, semTelefone = 0, jaExistiam = 0, falhas = 0;
  for (const r of cand) {
    const pedido = trim(r.pedido);
    const token = gerarToken();
    let ins;
    try {
      ins = await Pg.connectAndQuery(`
        INSERT INTO tab_nps_convite (token, pedido, filial, cliente_cod, cliente_loja, cliente_nome, cnpj, telefone, nf, valor_pedido, status, expira_em)
        VALUES (@token, @pedido, '01', @cod, @loja, @nome, @cnpj, @tel, @nf, @valor, 'PENDENTE', NOW() + (@dias || ' days')::interval)
        ON CONFLICT (filial, pedido) DO NOTHING
        RETURNING id`,
        {
          token, pedido, cod: trim(r.cod), loja: trim(r.loja), nome: trim(r.nome), cnpj: trim(r.cgc),
          tel: null, nf: trim(r.nf), valor: N(r.valor), dias: String(cfg.expiraDias)
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

  return { candidatos: cand.length, criados, enviados, semTelefone, jaExistiam, falhas };
}

module.exports = { gerarToken, lerConfig, classificar, dispararWhatsapp, linkPesquisa, BASE_PUBLICA, TPL_NPS, processarFaturados };

// services/expedicaoAviso.js — Pré-Expedição / Confirmação de Recebimento.
// Poll: acha pedidos que ENTRARAM na separação de estoque (pedidos_estatus com
// MIN(estatus_cod)=50), cria o aviso (dedupe por filial+pedido) e dispara um
// WhatsApp (Suri) com o link CONFIRMAR/RECUSAR/REAGENDAR. Espelha o npsPosvenda:
// só roda com o módulo ATIVO (tab_expedicao_config.ativo) + template Suri
// (SURI_TPL_EXPEDICAO) configurado. Sem esses dois, fica dormente.

const crypto = require('crypto');
const Suri = require('./suri');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

const BASE_PUBLICA = () => (process.env.EXPEDICAO_BASE_URL || process.env.NPS_BASE_URL || 'https://intranew.gnatus.com.br').replace(/\/$/, '');
const linkReagendar = (token) => `${BASE_PUBLICA()}/reagendar/${token}`;

// Template Suri (aprovado no Meta). Params: [nome, pedido, link].
const TPL_EXP = () => trim(process.env.SURI_TPL_EXPEDICAO);

function gerarToken() {
  return crypto.randomBytes(18).toString('base64url');   // ~24 chars url-safe
}

async function lerConfig(Pg) {
  const rows = await Pg.connectAndQuery(`SELECT chave, valor FROM tab_expedicao_config`, {});
  const cfg = {};
  rows.forEach((r) => { cfg[r.chave] = r.valor; });
  return {
    ativo: cfg.ativo === true || cfg.ativo === 'true',
    dataInicio: cfg.dataInicio || null,   // 'YYYY-MM-DD' — piso por C5_EMISSAO
    expiraDias: N(cfg.expiraDias ?? 15),
    mensagem: cfg.mensagem || {}
  };
}

// Telefone a partir da SA1 (mesma regra do NPS): A1_DDDCEL guarda SÓ o DDD; o
// número vem de A1_TEL; DDD de A1_DDD (fallback A1_DDDCEL). Strip de zero à esq.
function montarTelefone(ddd, dddcel, tel) {
  const soDig = (s) => String(s || '').replace(/\D/g, '');
  const d = (soDig(ddd) || soDig(dddcel)).replace(/^0+/, '');
  const n = soDig(tel);
  return n ? (d + n) : '';
}

async function dispararWhatsapp({ telefone, nome, pedido, token }) {
  const tpl = TPL_EXP();
  if (!tpl) return { ok: false, motivo: 'template_nao_configurado' };
  const phone = Suri.normalizePhone(telefone);
  if (!phone) return { ok: false, motivo: 'telefone_invalido' };
  try {
    const resp = await Suri.enviarTemplateId({
      phone, templateId: tpl,
      parameters: [trim(nome) || 'Cliente', trim(pedido), linkReagendar(token)]
    });
    return { ok: resp.ok === true, motivo: resp.ok ? 'enviado' : (resp.erro || 'falha_suri'), raw: resp.raw };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}

// Poll do scheduler. Pedidos cujo estágio ATUAL (menor estatus entre os itens) é
// 50 (Estoque/separação), emitidos a partir de config.dataInicio. Dedupe por
// (filial, pedido) no INSERT — pedido já avisado é ignorado (ON CONFLICT).
async function processar(app) {
  const { Pg, Protheus } = app.services;
  const cfg = await lerConfig(Pg);
  if (!cfg.ativo) return { skipped: 'inativo' };
  if (!TPL_EXP()) return { skipped: 'sem_template_suri' };
  if (!cfg.dataInicio) return { skipped: 'sem_dataInicio' };

  const dini = String(cfg.dataInicio).replace(/-/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(dini)) return { skipped: 'dataInicio_invalida' };

  let cand;
  try {
    cand = await Protheus.connectAndQuery(`
      SELECT TOP 200
             RTRIM(sc5.C5_NUM) pedido, RTRIM(sc5.C5_CLIENTE) cod, RTRIM(sc5.C5_LOJACLI) loja,
             RTRIM(sa1.A1_NOME) nome, RTRIM(sa1.A1_CGC) cgc,
             RTRIM(sa1.A1_DDDCEL) dddcel, RTRIM(sa1.A1_DDD) ddd, RTRIM(sa1.A1_TEL) tel,
             RTRIM(sc5.C5_ZTIPO) buCod, RTRIM(x5.X5_DESCRI) buNome,
             RTRIM(sc5.C5_VEND1) vendCod, RTRIM(sa3.A3_NOME) vendNome,
             CAST(ISNULL(tp.total, 0) AS NUMERIC(15,2)) valor
        FROM SC5010 sc5 WITH (NOLOCK)
        JOIN (SELECT c6_num, MIN(estatus_cod) mn FROM pedidos_estatus WITH (NOLOCK)
               WHERE c6_filial = '01' GROUP BY c6_num) pe
          ON pe.c6_num = sc5.C5_NUM AND pe.mn = 50
        LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = sc5.C5_CLIENTE AND sa1.A1_LOJA = sc5.C5_LOJACLI AND sa1.D_E_L_E_T_ <> '*'
        LEFT JOIN total_pedido_sc6 tp WITH (NOLOCK) ON tp.c6_num = sc5.C5_NUM
        LEFT JOIN SX5010 x5 WITH (NOLOCK) ON RTRIM(x5.X5_TABELA) = 'Z1' AND RTRIM(x5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND x5.D_E_L_E_T_ <> '*'
        LEFT JOIN SA3010 sa3 WITH (NOLOCK) ON sa3.A3_COD = sc5.C5_VEND1 AND sa3.D_E_L_E_T_ <> '*'
       WHERE sc5.C5_FILIAL = '01' AND sc5.D_E_L_E_T_ <> '*' AND sc5.C5_EMISSAO >= @dini
       ORDER BY sc5.C5_EMISSAO DESC`, { dini });
  } catch (e) {
    console.error('[expedicao] falha ao buscar pedidos em separação:', e.message);
    return { erro: e.message };
  }

  let criados = 0, enviados = 0, semTelefone = 0, jaExistiam = 0, falhas = 0;
  for (const r of cand) {
    const pedido = trim(r.pedido);
    if (!pedido) continue;
    const token = gerarToken();

    let ins;
    try {
      ins = await Pg.connectAndQuery(`
        INSERT INTO tab_expedicao_aviso (token, filial, pedido, cliente_cod, cliente_loja, cliente_nome, cnpj,
                                         bu_cod, bu_nome, vendedor_cod, vendedor_nome, valor_pedido, status, expira_em)
        VALUES (@token, '01', @pedido, @cod, @loja, @nome, @cnpj,
                @buCod, @buNome, @vendCod, @vendNome, @valor, 'PENDENTE', NOW() + (@dias || ' days')::interval)
        ON CONFLICT (filial, pedido) DO NOTHING
        RETURNING id`,
        {
          token, pedido, cod: trim(r.cod), loja: trim(r.loja), nome: trim(r.nome), cnpj: trim(r.cgc),
          buCod: trim(r.buCod), buNome: trim(r.buNome), vendCod: trim(r.vendCod), vendNome: trim(r.vendNome),
          valor: N(r.valor), dias: String(cfg.expiraDias)
        });
    } catch (e) { console.warn('[expedicao] insert aviso:', e.message); falhas++; continue; }
    if (!ins.length) { jaExistiam++; continue; }   // já avisado (dedupe)
    criados++;
    const avisoId = ins[0].id;

    const brutoTel = montarTelefone(r.ddd, r.dddcel, r.tel);
    const telNorm = Suri.normalizePhone(brutoTel);
    const disp = await dispararWhatsapp({ telefone: brutoTel, nome: trim(r.nome), pedido, token });

    if (disp.ok) {
      enviados++;
      await Pg.connectAndQuery(
        `UPDATE tab_expedicao_aviso SET status='ENVIADO', telefone=@tel, enviado_em=NOW(), envio_resposta=@r::jsonb WHERE id=@id`,
        { tel: telNorm, r: JSON.stringify(disp.raw || { motivo: disp.motivo }), id: avisoId });
    } else {
      if (disp.motivo === 'telefone_invalido') semTelefone++; else falhas++;
      await Pg.connectAndQuery(
        `UPDATE tab_expedicao_aviso SET status='ERRO', telefone=@tel, envio_resposta=@r::jsonb WHERE id=@id`,
        { tel: telNorm, r: JSON.stringify({ motivo: disp.motivo }), id: avisoId });
    }
  }

  return { candidatos: cand.length, criados, enviados, semTelefone, jaExistiam, falhas };
}

module.exports = { gerarToken, lerConfig, montarTelefone, dispararWhatsapp, linkReagendar, BASE_PUBLICA, TPL_EXP, processar };

// services/nfseWriteback.js — grava a chave da NFS-e (Padrão Nacional) de volta no
// Protheus via endpoint REST custom do Diego (POST /rest/NFSe/writeback) e reconcilia
// as linhas EMITIDA de PRODUÇÃO de tab_nfse_emitida que ainda não têm writeback.
//
// A intranet é read-only no Protheus EXCETO por writes acordados; este é um deles
// (grava F2_XNFSCHV/NUM/DT/SIT na SF2). Contrato: handoff Diego 31/07 + parecer 29/07.
//
// ⚠️ GUARDA DE AMBIENTE: só processa linhas ambiente='producao'. A chave de homologação
// (restrita, tpAmb 2) JAMAIS pode ir pro SF2 de produção — o contrato do Diego não tem
// campo de ambiente, então a guarda é 100% NOSSA (o 409 CHAVE_DIVERGENTE é só backstop).
//
// Config (.env): PROTHEUS_NFSE_URL (default = PROTHEUS_API_URL), PROTHEUS_API_USER/PASS
// (mesma credencial do contcega/SC001), PROTHEUS_NFSE_PATH_{WRITEBACK,DIAG,CONSULTA}.

const { fetchProtheusComRetry, ehConexao } = require('./protheusErro');

const trim = (v) => String(v == null ? '' : v).trim();

// emitido_em (Date/timestamptz) -> 'YYYY-MM-DD' (F2_XNFSDT é char(8); Diego aceita
// YYYY-MM-DD ou YYYYMMDD; omitido usa dDataBase do lado dele).
function ymd(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function config() {
  const base = (trim(process.env.PROTHEUS_NFSE_URL) || trim(process.env.PROTHEUS_API_URL)).replace(/\/$/, '');
  return {
    base,
    pathWriteback: trim(process.env.PROTHEUS_NFSE_PATH_WRITEBACK) || '/NFSe/writeback',
    pathDiag:      trim(process.env.PROTHEUS_NFSE_PATH_DIAG)      || '/NFSe/diag',
    pathConsulta:  trim(process.env.PROTHEUS_NFSE_PATH_CONSULTA)  || '/NFSe/consulta',
    user: trim(process.env.PROTHEUS_API_USER),
    pass: trim(process.env.PROTHEUS_API_PASS),
    configurado: !!(trim(process.env.PROTHEUS_NFSE_URL) || trim(process.env.PROTHEUS_API_URL)) && !!trim(process.env.PROTHEUS_API_USER)
  };
}

const authHeader = (cfg) => 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');

// Retorna sempre { ok, httpStatus, body } — nunca lança por status HTTP; erro de
// conexão vira { ok:false, httpStatus:0, erroConexao:true }.
async function _req(url, opts, timeoutMs) {
  try {
    const { ok, status, txt } = await fetchProtheusComRetry(url, opts, { tentativas: 2, timeoutMs });
    let body; try { body = JSON.parse(txt); } catch { body = { raw: String(txt || '').slice(0, 800) }; }
    return { ok, httpStatus: status, body };
  } catch (e) {
    return { ok: false, httpStatus: 0, erroConexao: ehConexao(e), body: { message: e.message } };
  }
}

// GET /NFSe/diag — CHAMAR ANTES de qualquer writeback. Se campos_ok=false, os F2_XNFS*
// não existem no Protheus e todo writeback dá 500 CAMPO_INEXISTENTE.
async function diag() {
  const cfg = config();
  if (!cfg.configurado) return { ok: false, httpStatus: 503, body: { message: 'API Protheus NFS-e não configurada (PROTHEUS_NFSE_URL/PROTHEUS_API_URL + USER/PASS).' } };
  return _req(cfg.base + cfg.pathDiag, { method: 'GET', headers: { Authorization: authHeader(cfg) } }, 15000);
}

// GET /NFSe/consulta — o que o ERP tem gravado (p/ reconciliar contra tab_nfse_emitida).
async function consultar({ filial = '01', serie = 'C', doc, cliente, loja }) {
  const cfg = config();
  if (!cfg.configurado) return { ok: false, httpStatus: 503, body: { message: 'API Protheus NFS-e não configurada.' } };
  const q = new URLSearchParams({ filial: trim(filial), serie: trim(serie) || 'C', doc: trim(doc), cliente: trim(cliente), loja: trim(loja) }).toString();
  return _req(`${cfg.base}${cfg.pathConsulta}?${q}`, { method: 'GET', headers: { Authorization: authHeader(cfg) } }, 20000);
}

// POST /NFSe/writeback — grava (ou simula) a chave de UMA nota. simular=true = dry-run.
async function gravar({ filial = '01', serie = 'C', doc, cliente, loja, nfse_chave, nfse_numero, data_autorizacao, situacao = 'A', simular = true }) {
  const cfg = config();
  if (!cfg.configurado) return { ok: false, httpStatus: 503, body: { message: 'API Protheus NFS-e não configurada.' } };
  const payload = {
    filial: trim(filial) || '01', serie: trim(serie) || 'C', doc: trim(doc),
    cliente: trim(cliente), loja: trim(loja), nfse_chave: trim(nfse_chave),
    situacao: trim(situacao) || 'A', simular: !!simular
  };
  const num = trim(nfse_numero); if (num) payload.nfse_numero = num;
  const dt = trim(data_autorizacao); if (dt) payload.data_autorizacao = dt;
  return _req(cfg.base + cfg.pathWriteback, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(cfg) },
    body: JSON.stringify(payload)
  }, 60000);
}

// Grava só o resultado do writeback na linha (não toca nfse_chave/status da emissão).
async function _marcar(Pg, id, writeback, resp) {
  await Pg.connectAndQuery(`
    UPDATE tab_nfse_emitida
       SET writeback     = @wb,
           retorno       = COALESCE(retorno, '{}'::jsonb) || @extra::jsonb,
           atualizado_em = NOW()
     WHERE id = @id`,
    {
      id, wb: writeback,
      extra: JSON.stringify({
        writeback: {
          at: new Date().toISOString(),
          httpStatus: resp.httpStatus,
          acao: (resp.body && resp.body.acao) || null,
          erro: resp.ok ? null : ((resp.body && (resp.body.codigo_erro || resp.body.message)) || null)
        }
      })
    });
}

// Reconcilia as notas EMITIDA de PRODUÇÃO sem writeback OK. Para cada uma chama
// /writeback (dry-run se simular). Só marca a coluna quando o Protheus CONFIRMA escrita.
//   simular=true (default) -> valida e localiza a nota, NÃO grava; writeback intacto.
//   simular=false          -> grava; GRAVADO/JA_GRAVADO -> writeback='OK'.
// Filtra SEMPRE ambiente='producao' (guarda). `id` opcional restringe a UMA linha.
async function reconciliar(app, { simular = true, limite = 25, id = null } = {}) {
  const { Pg } = app.services;
  const cfg = config();
  if (!cfg.configurado) return { ok: false, erro: 'NAO_CONFIGURADO', message: 'API Protheus NFS-e não configurada (PROTHEUS_NFSE_URL/PROTHEUS_API_URL + USER/PASS).' };

  // 1) diag primeiro — sem campos, todo writeback é 500; aborta com aviso claro.
  const d = await diag();
  const camposOk = !!(d.body && (d.body.campos_ok === true || d.body.campos_ok === 'true'));
  if (!d.ok || !camposOk) {
    return { ok: false, erro: 'CAMPOS_INDISPONIVEIS', httpStatus: d.httpStatus, diag: d.body,
      message: 'GET /NFSe/diag não confirmou campos_ok=true — F2_XNFS* indisponíveis no Protheus. Nada foi enviado.' };
  }

  // 2) candidatas: EMITIDA, produção, chave de 50 díg, ainda sem writeback OK.
  const lim = Math.min(Math.max(parseInt(limite, 10) || 25, 1), 200);
  const cond = [`status = 'EMITIDA'`, `ambiente = 'producao'`, `writeback <> 'OK'`,
    `nfse_chave IS NOT NULL`, `length(trim(nfse_chave)) = 50`];
  const params = {};
  if (id != null) { cond.push(`id = @id`); params.id = parseInt(id, 10); }
  const rows = await Pg.connectAndQuery(`
    SELECT id, filial, serie, doc, cliente, loja, nfse_chave, nfse_numero, emitido_em
      FROM tab_nfse_emitida
     WHERE ${cond.join(' AND ')}
     ORDER BY id ASC LIMIT ${lim}`, params);

  const resultados = [];
  for (const r of rows) {
    const resp = await gravar({
      filial: trim(r.filial) || '01', serie: trim(r.serie) || 'C', doc: trim(r.doc),
      cliente: trim(r.cliente), loja: trim(r.loja), nfse_chave: trim(r.nfse_chave),
      nfse_numero: trim(r.nfse_numero), data_autorizacao: ymd(r.emitido_em),
      situacao: 'A', simular
    });
    const acao = trim(resp.body && resp.body.acao);
    const gravou = resp.ok && (acao === 'GRAVADO' || acao === 'JA_GRAVADO');
    const divergente = resp.httpStatus === 409;

    let novoWb = null;
    if (!simular && gravou) novoWb = 'OK';
    else if (divergente) novoWb = 'DIVERGENTE';   // p/ revisão humana; não sobrescreve a chave
    if (novoWb) await _marcar(Pg, r.id, novoWb, resp);

    resultados.push({
      id: r.id, doc: trim(r.doc), cliente: trim(r.cliente), loja: trim(r.loja),
      httpStatus: resp.httpStatus, acao: acao || null, ok: !!resp.ok,
      gravou, divergente,
      writeback: novoWb || (simular ? 'SIMULADO' : 'PENDENTE'),
      erro: resp.ok ? null : ((resp.body && (resp.body.codigo_erro || resp.body.message)) || (resp.erroConexao ? 'CONEXAO' : 'ERRO'))
    });
  }

  const resumo = {
    candidatas: rows.length,
    gravadas:   resultados.filter((x) => !simular && x.gravou).length,
    simuladas:  resultados.filter((x) => simular && x.ok).length,
    divergentes: resultados.filter((x) => x.divergente).length,
    falhas:     resultados.filter((x) => !x.ok && !x.divergente).length
  };
  return { ok: true, simular: !!simular, campos_ok: true, resumo, resultados };
}

module.exports = { config, diag, consultar, gravar, reconciliar };

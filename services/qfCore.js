// services/qfCore.js — Qualificação de Fornecedores: tudo que precisa de banco.
//
//  - níveis de permissão (23001..23006, hierárquicos)
//  - trilha campo a campo (tab_qf_log, append-only)
//  - versão de regra ativa + configuração do módulo
//  - recálculo do IQF materializado no fornecedor + ações por mudança de classe
//    (PRO 7.3.7 / item 4.8: C notifica, D exige plano + inspeção 100%, E suspende)
//  - notificações idempotentes (tab_qf_notificacao)
//  - situação dos documentos dos fornecedores críticos
//  - leitura do cadastro de fornecedores do Protheus (SA2010, só leitura)
//
// As fórmulas em si ficam em ./qfRegras (puro, testado).

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const R = require('./qfRegras');
const Email = require('./emailService');

const PERM = { CONSULTA: 23001, INSPETOR: 23002, ENGENHARIA: 23003, QUALIDADE: 23004, GERENTE: 23005, ADMIN: 23006 };
// Cada nível inclui os de cima (especificação, item 6). 0 = admin universal da intranet.
const NIVEL = {
  consulta:   [23001, 23002, 23003, 23004, 23005, 23006, 0],
  inspetor:   [23002, 23003, 23004, 23005, 23006, 0],
  engenharia: [23003, 23004, 23005, 23006, 0],
  qualidade:  [23004, 23005, 23006, 0],
  gerente:    [23005, 23006, 0],
  admin:      [23006, 0]
};

const BASE_URL = () => (process.env.INTRANET_URL || process.env.FRONTEND_URL || 'https://intranew.gnatus.com.br').replace(/\/$/, '');

const trim = (v) => (v == null ? '' : String(v).trim());
const nul = (v) => { const s = trim(v); return s === '' ? null : s; };
const r4 = (x) => (x == null ? null : Math.round(Number(x) * 10000) / 10000);

function mw(app, nivel) {
  return require('../middlewares/requirePerm')(app)(NIVEL[nivel]);
}

function usuario(req) {
  const u = req && req.user && req.user[0];
  return { id: u ? Number(u.id ?? u.ID) : null, nome: u ? (u.nome ?? u.NOME) : null, email: u ? (u.email ?? u.EMAIL) : null };
}

function ipDe(req) {
  if (!req) return null;
  const fwd = req.headers && req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' ? fwd.split(',')[0].trim() : null) || req.ip || null;
}

async function permsDoUsuario(Pg, userId) {
  if (!userId) return [];
  const r = await Pg.connectAndQuery(`SELECT id_permissao FROM tab_intranet_usr_permissoes WHERE id_user = @id`, { id: userId });
  return r.map(x => Number(x.id_permissao));
}
const temNivel = (perms, nivel) => NIVEL[nivel].some(p => perms.includes(p));

async function niveisDoUsuario(Pg, req) {
  const perms = await permsDoUsuario(Pg, usuario(req).id);
  const out = {};
  for (const k of Object.keys(NIVEL)) out[k] = temNivel(perms, k);
  return out;
}

// ---------------------------------------------------------------- transação com @placeholders
async function tx(Pg, fn) {
  return Pg.withTransaction(async (client) => {
    const q = async (sql, params = {}) => {
      const { sql: s, values } = Pg._traduzirPlaceholders(Pg._traduzirSintaxe(sql), params);
      const r = await client.query(s, values);
      return r.rows;
    };
    return fn(q);
  });
}

// ---------------------------------------------------------------- trilha
const fmtValor = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

// Lista de mudanças entre dois objetos, só nos campos informados.
function diff(antes, depois, campos) {
  const out = [];
  for (const c of campos) {
    const a = fmtValor(antes ? antes[c] : null), d = fmtValor(depois ? depois[c] : null);
    const na = a != null && !isNaN(Number(a)) && a.trim() !== '' ? String(Number(a)) : a;
    const nd = d != null && !isNaN(Number(d)) && d.trim() !== '' ? String(Number(d)) : d;
    const ad = na && /^\d{4}-\d{2}-\d{2}/.test(na) ? na.slice(0, 10) : na;
    const dd = nd && /^\d{4}-\d{2}-\d{2}/.test(nd) ? nd.slice(0, 10) : nd;
    if (ad !== dd) out.push({ campo: c, de: a, para: d });
  }
  return out;
}

// Grava a trilha. `q` opcional = executor de transação (tx); sem ele usa o pool.
async function log(Pg, req, { entidade, entidadeId, fornecedorId, acao, mudancas, motivo }, q) {
  const u = usuario(req);
  const linhas = (mudancas && mudancas.length ? mudancas : [{ campo: null, de: null, para: null }]).map(m => ({
    entidade, entidade_id: entidadeId ?? null, fornecedor_id: fornecedorId ?? null, acao,
    campo: m.campo, valor_anterior: fmtValor(m.de), valor_novo: fmtValor(m.para),
    motivo: nul(motivo), usuario_id: u.id, usuario_nome: u.nome || (req ? null : 'sistema'), ip: ipDe(req)
  }));
  const sql = `INSERT INTO tab_qf_log (entidade, entidade_id, fornecedor_id, acao, campo, valor_anterior, valor_novo, motivo, usuario_id, usuario_nome, ip)
    SELECT entidade, entidade_id, fornecedor_id, acao, campo, valor_anterior, valor_novo, motivo, usuario_id, usuario_nome, ip
      FROM jsonb_to_recordset(@rows::jsonb) AS x(entidade text, entidade_id int, fornecedor_id int, acao text, campo text,
           valor_anterior text, valor_novo text, motivo text, usuario_id int, usuario_nome text, ip text)`;
  const params = { rows: JSON.stringify(linhas) };
  try {
    if (q) await q(sql, params); else await Pg.connectAndQuery(sql, params);
  } catch (e) {
    // dentro de transação o erro precisa subir (a operação inteira volta); fora, só registra
    if (q) throw e;
    console.error('[qf] falha ao gravar trilha:', e.message);
  }
}

// ---------------------------------------------------------------- regra + config
async function regraAtiva(Pg) {
  const r = await Pg.connectAndQuery(`SELECT id, nome, referencia, conteudo FROM tab_qf_regra_versao WHERE ativa LIMIT 1`);
  if (!r.length) throw new Error('Nenhuma versão de regra ativa (tab_qf_regra_versao).');
  return { id: r[0].id, nome: r[0].nome, referencia: r[0].referencia, conteudo: r[0].conteudo };
}

async function regraPorId(Pg, id) {
  const r = await Pg.connectAndQuery(`SELECT id, nome, referencia, conteudo FROM tab_qf_regra_versao WHERE id = @id`, { id });
  return r[0] || null;
}

async function config(Pg) {
  const r = await Pg.connectAndQuery(`SELECT chave, valor FROM tab_qf_config`);
  const c = {};
  r.forEach(x => { c[x.chave] = x.valor; });
  return {
    emails_qualidade: Array.isArray(c.emails_qualidade) ? c.emails_qualidade : [],
    emails_engenharia: Array.isArray(c.emails_engenharia) ? c.emails_engenharia : [],
    acoes_automaticas: c.acoes_automaticas !== false,
    suspender_doc_vencido: c.suspender_doc_vencido !== false,
    suspender_requalificacao_vencida: c.suspender_requalificacao_vencida !== false,
    dias_alerta_requalificacao: Array.isArray(c.dias_alerta_requalificacao) ? c.dias_alerta_requalificacao.map(Number) : [60, 30],
    email_fornecedor: c.email_fornecedor === true,
    dias_alerta_documento: Array.isArray(c.dias_alerta_documento) ? c.dias_alerta_documento.map(Number) : [30, 1],
    questionario_validade_dias: Number(c.questionario_validade_dias) || 30
  };
}

// ---------------------------------------------------------------- notificações
// `chave` única impede reenviar o mesmo aviso. `externo` = e-mail ao fornecedor,
// que só sai com a chave `email_fornecedor` ligada na configuração.
async function notificar(app, { chave, tipo, entidade, entidadeId, fornecedorId, para, assunto, texto, externo = false }) {
  const { Pg } = app.services;
  const cfg = await config(Pg);
  const dest = [...new Set((para || []).map(trim).filter(e => /.+@.+\..+/.test(e)))];
  const ins = await Pg.connectAndQuery(
    `INSERT INTO tab_qf_notificacao (chave, tipo, entidade, entidade_id, fornecedor_id, destinatarios, assunto)
     VALUES (@chave, @tipo, @ent, @eid, @fid, @dest, @assunto)
     ON CONFLICT (chave) DO NOTHING RETURNING id`,
    { chave: String(chave).slice(0, 160), tipo, ent: entidade || null, eid: entidadeId || null, fid: fornecedorId || null, dest: dest.join(', ') || null, assunto: String(assunto).slice(0, 250) });
  if (!ins.length) return { duplicada: true };
  const id = ins[0].id;
  let erro = null, enviado = false;
  if (externo && !cfg.email_fornecedor) erro = 'envio ao fornecedor desligado na configuração';
  else if (!dest.length) erro = 'sem destinatário configurado';
  else {
    try {
      await Email.sendEmail({ to: dest.join(','), subject: assunto, text: `${texto}\n\n— Intranet GNATUS · Qualificação de Fornecedores\n${BASE_URL()}/qualificacao-fornecedores` });
      enviado = true;
    } catch (e) { erro = String(e.message || e).slice(0, 500); }
  }
  await Pg.connectAndQuery(`UPDATE tab_qf_notificacao SET enviado = @env, erro = @erro WHERE id = @id`, { env: enviado, erro, id });
  return { id, enviado, erro };
}

// ---------------------------------------------------------------- IQF + classe
const ORDEM = 'ABCDE';
const STATUS_ATIVOS = ['APROVADO', 'APROVADO_COM_RESTRICAO'];
const TIPOS_PLANO = ['PLANO_ACAO_C', 'PLANO_ACAO_D'];
const iqfTxt = (v) => (v != null ? Number(v).toFixed(2).replace('.', ',') : '—');

// Bloqueio do fornecedor. `tipo`: PLANO_ACAO_C | PLANO_ACAO_D | DOCUMENTO | REQUALIFICACAO | MANUAL.
async function suspender(app, fornecedor, motivo, req, tipo = 'MANUAL', origem = 'AUTOMATICO') {
  const { Pg } = app.services;
  const r = await Pg.connectAndQuery(
    `UPDATE tab_qf_fornecedor SET status_qualificacao = 'SUSPENSO', suspensao_tipo = @tipo, motivo_suspensao = @m, suspenso_em = NOW(), atualizado_em = NOW()
      WHERE id = @id AND status_qualificacao <> 'SUSPENSO' RETURNING id`, { id: fornecedor.id, m: motivo, tipo });
  if (!r.length) return false;
  await log(Pg, req, {
    entidade: 'fornecedor', entidadeId: fornecedor.id, fornecedorId: fornecedor.id, acao: origem === 'AUTOMATICO' ? 'SUSPENSAO_AUTOMATICA' : 'SUSPENSAO',
    mudancas: [{ campo: 'status_qualificacao', de: fornecedor.status_qualificacao, para: 'SUSPENSO' }, { campo: 'suspensao_tipo', para: tipo }], motivo
  });
  await avisarBloqueio(app, fornecedor, motivo, tipo);
  return true;
}

// Decisão 30/10 (item 7): enquanto não há integração com o ERP, cada bloqueio vira um
// aviso à Engenharia para inativar o fornecedor no Protheus (e reativar depois).
async function avisarBloqueio(app, f, motivo, tipo) {
  const cfg = await config(app.services.Pg);
  const nome = `${f.codigo} – ${f.razao_social}`;
  await notificar(app, {
    chave: `bloqueio|${f.id}|${tipo}|${new Date().toISOString().slice(0, 10)}`, tipo: 'BLOQUEIO', entidade: 'fornecedor', entidadeId: f.id, fornecedorId: f.id,
    para: [...cfg.emails_engenharia, ...cfg.emails_qualidade],
    assunto: `[Bloquear no Protheus] ${nome}`,
    texto: [
      `O fornecedor ${nome} foi bloqueado no módulo de Qualificação de Fornecedores.`,
      `Motivo: ${motivo}`, '',
      `Providência: INATIVAR o fornecedor no Protheus (cadastro SA2 — bloqueio) para evitar novos pedidos de compra, até a liberação no módulo.`,
      TIPOS_PLANO.includes(tipo) ? 'A liberação acontece quando a Engenharia registrar o plano de ação do fornecedor (com o anexo) na ficha do fornecedor.' : ''
    ].filter(Boolean).join('\n')
  });
}

// Ações por classe — PRO 7.3.7 OUT261 item 5.9 com a decisão de 30/10/2026:
//   C (BLOQUEAR_PLANO): bloqueia o recebimento até a Engenharia registrar o plano de ação;
//                       liberado, volta a receber por amostragem.
//   D (BLOQUEAR_PLANO_100): idem, e após o plano só recebe com inspeção 100% do lote.
//   E (REPROVAR): reprova e inativa o fornecedor (volta só por nova qualificação).
// Só para fornecedor CRÍTICO (monitorado). Melhorar de classe não libera sozinho.
async function aplicarAcoesClasse(app, f, antes, depois, regra, req) {
  const { Pg } = app.services;
  const cfg = await config(Pg);
  if (!depois || !cfg.acoes_automaticas) return { acao: cfg.acoes_automaticas ? 'NENHUMA' : 'DESLIGADA' };
  const piorou = !antes || ORDEM.indexOf(depois) > ORDEM.indexOf(antes);
  const k = (regra.classes || []).find(c => c.classe === depois);
  const acao = k ? k.acao : 'NENHUMA';
  const nome = `${f.codigo} – ${f.razao_social}`;

  // melhora: sai da exigência de 100% quando deixa a classe D
  if (!piorou) {
    if (f.inspecao_100 && ORDEM.indexOf(depois) < ORDEM.indexOf('D')) {
      await Pg.connectAndQuery(`UPDATE tab_qf_fornecedor SET inspecao_100 = FALSE,
                suspensao_tipo = CASE WHEN suspensao_tipo = 'PLANO_ACAO_D' THEN 'PLANO_ACAO_C' ELSE suspensao_tipo END WHERE id = @id`, { id: f.id });
      await log(Pg, req, { entidade: 'fornecedor', entidadeId: f.id, fornecedorId: f.id, acao: 'CLASSE', mudancas: [{ campo: 'inspecao_100', de: true, para: false }], motivo: `subiu para a classe ${depois}: volta a receber por amostragem` });
    }
    return { acao: 'NENHUMA' };
  }

  let bloqueado = false, reprovado = false;
  const motivoBase = `IQF médio ${iqfTxt(f.iqf_medio)} — classe ${depois} (${k ? k.rotulo : ''}).`;
  if (acao === 'BLOQUEAR_PLANO' || acao === 'BLOQUEAR_PLANO_100') {
    const tipo = acao === 'BLOQUEAR_PLANO' ? 'PLANO_ACAO_C' : 'PLANO_ACAO_D';
    const motivo = `${motivoBase} Recebimento bloqueado até a Engenharia registrar o plano de ação do fornecedor${tipo === 'PLANO_ACAO_D' ? '; depois, só com inspeção de 100% do lote' : ''}.`;
    if (tipo === 'PLANO_ACAO_D') {
      await Pg.connectAndQuery(`UPDATE tab_qf_fornecedor SET inspecao_100 = TRUE WHERE id = @id`, { id: f.id });
      await log(Pg, req, { entidade: 'fornecedor', entidadeId: f.id, fornecedorId: f.id, acao: 'CLASSE', mudancas: [{ campo: 'inspecao_100', de: f.inspecao_100, para: true }], motivo: 'classe D: recebimento só com inspeção 100%' });
    }
    // novo bloqueio exige NOVO plano: o anterior fica na trilha
    await Pg.connectAndQuery(`UPDATE tab_qf_fornecedor SET plano_acao_iqf = NULL, plano_acao_iqf_em = NULL, plano_acao_iqf_por = NULL WHERE id = @id`, { id: f.id });
    if (STATUS_ATIVOS.includes(f.status_qualificacao)) bloqueado = await suspender(app, f, motivo, req, tipo);
    else if (f.status_qualificacao === 'SUSPENSO' && TIPOS_PLANO.includes(f.suspensao_tipo) && f.suspensao_tipo !== tipo) {
      await Pg.connectAndQuery(`UPDATE tab_qf_fornecedor SET suspensao_tipo = @t, motivo_suspensao = @m WHERE id = @id`, { id: f.id, t: tipo, m: motivo });
      await log(Pg, req, { entidade: 'fornecedor', entidadeId: f.id, fornecedorId: f.id, acao: 'CLASSE', mudancas: [{ campo: 'suspensao_tipo', de: f.suspensao_tipo, para: tipo }], motivo });
    }
  }
  if (acao === 'REPROVAR' && f.status_qualificacao !== 'REPROVADO') {
    const motivo = `${motivoBase} Reprovado e inativado (decisão 30/10/2026); volta somente por nova qualificação.`;
    await Pg.connectAndQuery(
      `UPDATE tab_qf_fornecedor SET status_qualificacao = 'REPROVADO', ativo = FALSE, suspensao_tipo = NULL, motivo_suspensao = @m, suspenso_em = NOW(), atualizado_em = NOW() WHERE id = @id`,
      { id: f.id, m: motivo });
    await log(Pg, req, { entidade: 'fornecedor', entidadeId: f.id, fornecedorId: f.id, acao: 'REPROVAR',
      mudancas: [{ campo: 'status_qualificacao', de: f.status_qualificacao, para: 'REPROVADO' }, { campo: 'ativo', de: f.ativo, para: false }], motivo });
    await avisarBloqueio(app, f, motivo, 'REPROVADO');
    reprovado = true;
  }
  await notificar(app, {
    chave: `classe|${f.id}|${antes || '-'}>${depois}|${new Date().toISOString().slice(0, 10)}`, tipo: 'CLASSE', entidade: 'fornecedor', entidadeId: f.id, fornecedorId: f.id,
    para: [...cfg.emails_engenharia, ...cfg.emails_qualidade],
    assunto: `[Fornecedor classe ${depois}] ${nome}${bloqueado ? ' — recebimento bloqueado' : reprovado ? ' — REPROVADO' : ''}`,
    texto: [`O fornecedor ${nome} passou da classe ${antes || '(sem classe)'} para ${depois} (IQF médio ${iqfTxt(f.iqf_medio)}).`,
      k ? `Situação: ${k.rotulo}.` : '',
      bloqueado ? 'Recebimento bloqueado até a Engenharia registrar o plano de ação do fornecedor no módulo.' : '',
      reprovado ? 'Fornecedor reprovado e inativado.' : ''].filter(Boolean).join('\n')
  });
  if (f.contato_email && (bloqueado || reprovado)) {
    await notificar(app, {
      chave: `classe|${f.id}|${depois}|fornecedor|${new Date().toISOString().slice(0, 10)}`, tipo: 'CLASSE_FORNECEDOR', entidade: 'fornecedor', entidadeId: f.id, fornecedorId: f.id,
      para: [f.contato_email], externo: true,
      assunto: `GNATUS — avaliação de desempenho de fornecedor (${f.razao_social})`,
      texto: `Prezado fornecedor,\n\nNa avaliação contínua de desempenho da GNATUS (IQF), sua empresa foi classificada na faixa ${depois} (${k ? k.rotulo : ''}).\n${reprovado ? 'A qualificação foi reprovada.' : 'Solicitamos o envio de um plano de ação para melhoria de conformidade e prazo de entrega. O recebimento fica suspenso até o plano ser aprovado.'}\n\nAtenciosamente,\nEngenharia — GNATUS`
    });
  }
  return { acao, bloqueado, reprovado };
}

// Recalcula média/quantidade/classe (só fornecedor CRÍTICO é classificado — decisão 30/10:
// não crítico continua registrando recebimento, mas não entra no monitoramento) e os
// gatilhos de auditoria de acompanhamento (PRO 5.6.2).
async function recalcularFornecedor(app, fornecedorId, { req = null, semAcoes = false, regra = null } = {}) {
  const { Pg } = app.services;
  const rg = regra || (await regraAtiva(Pg)).conteudo;
  const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id: fornecedorId });
  if (!f) return null;
  const hist = await Pg.connectAndQuery(
    `SELECT iqf, nc, data_inspecao FROM tab_qf_inspecao
      WHERE fornecedor_id = @id AND NOT excluido AND iqf IS NOT NULL
        AND (@desde::date IS NULL OR data_inspecao >= @desde::date)
      ORDER BY data_inspecao NULLS FIRST, rel_insp`, { id: fornecedorId, desde: f.iqf_desde || null });
  let soma = 0;
  const mediasApos = hist.map((h, i) => { soma += Number(h.iqf); return soma / (i + 1); });
  const media = hist.length ? r4(soma / hist.length) : null;
  const ultima = hist.reduce((m, h) => (h.data_inspecao && (!m || h.data_inspecao > m) ? h.data_inspecao : m), null);
  const monit = R.monitorado(f);
  const cls = monit ? (R.classificar(rg, media)?.classe || null) : null;
  const meses = (rg.auditoriaAcompanhamento && rg.auditoriaAcompanhamento.ncsJanelaMeses) || 6;
  const corte = new Date(); corte.setMonth(corte.getMonth() - meses);
  const ncsDatas = hist.filter(h => h.nc && h.data_inspecao && new Date(h.data_inspecao) >= corte).map(h => h.data_inspecao);
  const [aud] = monit ? await Pg.connectAndQuery(`SELECT MAX(data_realizada) d FROM tab_qf_auditoria WHERE fornecedor_id = @id AND status = 'REALIZADA'`, { id: fornecedorId }) : [null];
  const motivosAud = monit ? R.auditoriaAcompanhamento(rg, { mediasApos, datas: hist.map(h => h.data_inspecao), ncsDatas, ultimaAuditoria: aud && aud.d }) : [];
  await Pg.connectAndQuery(
    `UPDATE tab_qf_fornecedor SET iqf_medio = @media, qtd_inspecoes = @qtd, classificacao = @cls, ultima_inspecao = @ult,
            auditoria_sugerida_motivo = @aud, iqf_atualizado_em = NOW()
      WHERE id = @id`, { id: fornecedorId, media, qtd: hist.length, cls, ult: ultima, aud: motivosAud.length ? motivosAud.join(' ') : null });
  let acoes = null;
  if ((f.classificacao || null) !== cls) {
    await log(Pg, req, {
      entidade: 'fornecedor', entidadeId: f.id, fornecedorId: f.id, acao: 'CLASSE',
      mudancas: [{ campo: 'classificacao', de: f.classificacao, para: cls }, { campo: 'iqf_medio', de: f.iqf_medio, para: media }],
      motivo: semAcoes ? 'recálculo (importação/regra/criticidade)' : 'recálculo após inspeção'
    });
    if (!semAcoes && monit) acoes = await aplicarAcoesClasse(app, { ...f, iqf_medio: media }, f.classificacao, cls, rg, req);
  }
  return { antes: f.classificacao || null, depois: cls, media, qtd: hist.length, monitorado: monit, acoes, auditoriaSugerida: motivosAud };
}

// Criticidade do item na lista de itens e serviços críticos (null = não crítico).
async function itemCriticidade(Pg, codItem) {
  const chave = R.chaveItem(codItem);
  if (!chave) return null;
  const [r] = await Pg.connectAndQuery(`SELECT criticidade, descricao FROM tab_qf_item_critico WHERE produto_chave = @k AND ativo`, { k: chave });
  return r || null;
}

// Desempenho dos últimos 12 meses (requalificação — PRO 5.10.1).
async function desempenho12m(Pg, regra, fornecedorId) {
  const [d] = await Pg.connectAndQuery(
    `SELECT COUNT(*)::int inspecoes, COUNT(*) FILTER (WHERE nc)::int ncs, AVG(iqf) media,
            COUNT(*) FILTER (WHERE COALESCE(NULLIF(UPPER(TRIM(rnc_numero)), 'N/A'), '') <> '')::int rncs,
            SUM(qtd_reprovada) reprovadas, SUM(qtd_inspecionada) inspecionadas
       FROM tab_qf_inspecao
      WHERE fornecedor_id = @id AND NOT excluido AND iqf IS NOT NULL
        AND data_inspecao > CURRENT_DATE - INTERVAL '12 months' AND data_inspecao <= CURRENT_DATE`, { id: fornecedorId });
  const media = d.inspecoes ? r4(d.media) : null;
  return { inspecoes: d.inspecoes, ncs: d.ncs, rncs: d.rncs, iqf: media, classe: R.classificar(regra, media)?.classe || null,
    pecasReprovadas: Number(d.reprovadas) || 0, pecasInspecionadas: Number(d.inspecionadas) || 0, semFornecimento: d.inspecoes === 0 };
}

// NCs nas últimas `janelaN` inspeções ANTERIORES (por data, depois nº do relatório).
async function ncsAnteriores(Pg, regra, { fornecedorId, codItem, dataInspecao, relInsp, excluirId }) {
  if (!fornecedorId || !dataInspecao) return { ncs: 0, entregas: [] };
  const porItem = regra.escopoN === 'FORNECEDOR_ITEM';
  const rows = await Pg.connectAndQuery(
    `SELECT id, rel_insp, data_inspecao, nc, cod_item, qtd_reprovada, rnc_numero
       FROM tab_qf_inspecao
      WHERE fornecedor_id = @f AND NOT excluido AND id <> @ex AND data_inspecao IS NOT NULL
        AND (data_inspecao < @d OR (data_inspecao = @d AND rel_insp < @rel))
        ${porItem ? `AND LTRIM(cod_item, '0') = LTRIM(@item, '0')` : ''}
      ORDER BY data_inspecao DESC, rel_insp DESC
      LIMIT @lim`,
    { f: fornecedorId, ex: excluirId || 0, d: dataInspecao, rel: relInsp || 2147483647, item: trim(codItem), lim: Number(regra.janelaN) || 3 });
  return { ncs: rows.filter(r => r.nc).length, entregas: rows };
}

async function proximoRelInsp(Pg) {
  const [r] = await Pg.connectAndQuery(`SELECT COALESCE(MAX(rel_insp), 0) + 1 AS n FROM tab_qf_inspecao`);
  return Number(r.n);
}

// ---------------------------------------------------------------- documentos
async function tiposDocumento(Pg) {
  return Pg.connectAndQuery(`SELECT * FROM tab_qf_tipo_documento WHERE ativo ORDER BY ordem, nome`);
}

async function checklistFornecedor(Pg, f, { tipos = null } = {}) {
  const t = tipos || await tiposDocumento(Pg);
  const docs = await Pg.connectAndQuery(`SELECT * FROM tab_qf_documento WHERE fornecedor_id = @id`, { id: f.id });
  const [ficha] = await Pg.connectAndQuery(`SELECT id, status, resultado FROM tab_qf_ficha WHERE fornecedor_id = @id AND formulario = '7.3.21' ORDER BY (status = 'ANALISADA') DESC, id DESC LIMIT 1`, { id: f.id });
  return R.checklistDocumentos(t, docs, f, ficha || null);
}

// Situação dos documentos de TODOS os fornecedores críticos (são poucos — dezenas).
// Fonte única para lista, dashboard e alertas: a regra fica no JS (qfRegras).
async function situacaoDocsCriticos(Pg) {
  const tipos = await tiposDocumento(Pg);
  const forns = await Pg.connectAndQuery(`SELECT id, codigo, razao_social, criticidades, nacional, status_qualificacao, suspensao_tipo, contato_email FROM tab_qf_fornecedor WHERE cardinality(criticidades) > 0 AND ativo`);
  if (!forns.length) return new Map();
  const ids = forns.map(f => f.id);
  const docs = await Pg.connectAndQuery(`SELECT * FROM tab_qf_documento WHERE fornecedor_id = ANY(@ids)`, { ids });
  const fichas = await Pg.connectAndQuery(
    `SELECT DISTINCT ON (fornecedor_id) fornecedor_id, id, status, resultado FROM tab_qf_ficha WHERE fornecedor_id = ANY(@ids) AND formulario = '7.3.21' ORDER BY fornecedor_id, (status = 'ANALISADA') DESC, id DESC`, { ids });
  const fichaDe = new Map(fichas.map(x => [x.fornecedor_id, x]));
  const out = new Map();
  for (const f of forns) {
    const ck = R.checklistDocumentos(tipos, docs.filter(d => d.fornecedor_id === f.id), f, fichaDe.get(f.id) || null);
    out.set(f.id, { fornecedor: f, ...ck });
  }
  return out;
}

// ---------------------------------------------------------------- Protheus (SA2010, leitura)
function mapSA2(r) {
  const uf = trim(r.uf).toUpperCase();
  const tel = [trim(r.ddd), trim(r.tel)].filter(Boolean).join(' ');
  // cortado no tamanho das colunas de tab_qf_fornecedor (um campo longo do ERP não pode derrubar o lote)
  const c = (v, n) => { const x = nul(v); return x ? x.slice(0, n) : null; };
  return {
    codigo: trim(r.cod), loja: c(r.loja, 4),
    razao_social: trim(r.nome).slice(0, 200), nome_fantasia: c(r.nreduz, 120),
    cnpj: c(r.cgc, 20), estado: uf ? uf.slice(0, 2) : null, nacional: uf !== 'EX',
    pais: uf === 'EX' ? 'Exterior' : 'Brasil',
    cidade: c(r.mun, 80), endereco: c(r.endereco, 200), cep: c(r.cep, 10),
    contato_nome: c(r.contato, 120), contato_email: nul(r.email) ? trim(r.email).toLowerCase().slice(0, 200) : null,
    contato_telefone: tel ? tel.slice(0, 40) : null,
    bloqueado_protheus: trim(r.blq) === '1'
  };
}

const SELECT_SA2 = `SELECT RTRIM(A2_COD) cod, RTRIM(A2_LOJA) loja, RTRIM(A2_NOME) nome, RTRIM(A2_NREDUZ) nreduz,
       RTRIM(A2_CGC) cgc, RTRIM(A2_EST) uf, RTRIM(A2_MUN) mun, RTRIM(A2_END) endereco, RTRIM(A2_CEP) cep,
       RTRIM(A2_EMAIL) email, RTRIM(A2_DDD) ddd, RTRIM(A2_TEL) tel, RTRIM(A2_CONTATO) contato, RTRIM(A2_MSBLQL) blq
  FROM SA2010 WITH (NOLOCK)`;

async function lerSA2(Protheus, codigo) {
  const r = await Protheus.connectAndQuery(`${SELECT_SA2}
     WHERE D_E_L_E_T_ <> '*' AND A2_COD = @cod ORDER BY A2_LOJA`, { cod: R.normalizarCodigo(codigo) });
  return r.length ? mapSA2(r[0]) : null;
}

async function buscarSA2(Protheus, q) {
  const s = trim(q).toUpperCase();
  if (!s) return [];
  const porCodigo = /^\d{1,6}$/.test(s);
  const r = await Protheus.connectAndQuery(`SELECT TOP 25 * FROM (
      ${SELECT_SA2.replace('SELECT ', 'SELECT ROW_NUMBER() OVER (PARTITION BY A2_COD ORDER BY A2_LOJA) rn, ')}
       WHERE D_E_L_E_T_ <> '*' AND ${porCodigo ? 'A2_COD = @cod' : '(A2_NOME LIKE @like OR A2_NREDUZ LIKE @like OR A2_CGC LIKE @doc)'}
    ) x WHERE rn = 1 ORDER BY nome`,
    { cod: R.normalizarCodigo(s), like: `%${s}%`, doc: `%${s.replace(/\D/g, '') || '#'}%` });
  return r.map(mapSA2);
}

// ---------------------------------------------------------------- assinatura eletrônica
async function verificarSenha(Pg, userId, senha) {
  if (!userId || !senha) return false;
  const r = await Pg.connectAndQuery(`SELECT senha FROM tab_intranet_usr WHERE id = @id AND ativo = true`, { id: userId });
  if (!r.length || !r[0].senha) return false;
  try { return bcrypt.compareSync(String(senha), r[0].senha); } catch { return false; }
}

const sha256 = (obj) => crypto.createHash('sha256').update(typeof obj === 'string' ? obj : JSON.stringify(obj)).digest('hex');

// Erro padrão de rota (não vaza detalhe do Postgres para o cliente).
function falha(res, rotulo, err) {
  console.error(`[qf] ${rotulo}:`, err);
  return res.status(500).json({ message: `Erro ao ${rotulo}.` });
}

// Traz da SA2 os fornecedores que faltam no módulo (como não críticos — a FORM 7.3.24
// sempre listou todo fornecedor do ERP) e atualiza nome/CNPJ/UF/país/bloqueio dos que já
// estão. Não mexe em criticidade, status nem SGQ. Usado pela tela e pela importação.
async function sincronizarSA2(app, req = null) {
  const { Pg, Protheus } = app.services;
  const sa2 = await Protheus.connectAndQuery(`SELECT * FROM (
      SELECT ROW_NUMBER() OVER (PARTITION BY A2_COD ORDER BY A2_LOJA) rn,
             RTRIM(A2_COD) cod, RTRIM(A2_LOJA) loja, RTRIM(A2_NOME) nome, RTRIM(A2_NREDUZ) nreduz, RTRIM(A2_CGC) cgc,
             RTRIM(A2_EST) uf, RTRIM(A2_MUN) mun, RTRIM(A2_END) endereco, RTRIM(A2_CEP) cep, RTRIM(A2_EMAIL) email,
             RTRIM(A2_DDD) ddd, RTRIM(A2_TEL) tel, RTRIM(A2_CONTATO) contato, RTRIM(A2_MSBLQL) blq
        FROM SA2010 WITH (NOLOCK) WHERE D_E_L_E_T_ <> '*' AND A2_COD LIKE '[0-9][0-9][0-9][0-9][0-9][0-9]'
    ) x WHERE rn = 1`);
  const linhas = sa2.map(mapSA2).filter(s => s.razao_social);
  const [antes] = await Pg.connectAndQuery(`SELECT COUNT(*)::int n FROM tab_qf_fornecedor`);
  const u = usuario(req);
  for (let i = 0; i < linhas.length; i += 1000) {
    await Pg.connectAndQuery(
      `INSERT INTO tab_qf_fornecedor (codigo, loja, razao_social, nome_fantasia, cnpj, pais, nacional, estado, cidade, endereco, cep,
              contato_nome, contato_email, contato_telefone, bloqueado_protheus, criticidades, status_qualificacao, origem, criado_por, pendencias)
       SELECT codigo, loja, razao_social, nome_fantasia, cnpj, pais, nacional, estado, cidade, endereco, cep,
              contato_nome, contato_email, contato_telefone, bloqueado_protheus, '{}', 'APROVADO', 'SA2', @u,
              ARRAY['incluído pela sincronização com o Protheus como não crítico — conferir os itens que fornece']
         FROM jsonb_to_recordset(@rows::jsonb) AS x(codigo text, loja text, razao_social text, nome_fantasia text, cnpj text, pais text,
              nacional boolean, estado text, cidade text, endereco text, cep text, contato_nome text, contato_email text,
              contato_telefone text, bloqueado_protheus boolean)
       ON CONFLICT (codigo) DO UPDATE SET
          razao_social = EXCLUDED.razao_social, nome_fantasia = EXCLUDED.nome_fantasia, cnpj = EXCLUDED.cnpj, pais = EXCLUDED.pais,
          nacional = EXCLUDED.nacional, estado = EXCLUDED.estado, cidade = EXCLUDED.cidade, endereco = EXCLUDED.endereco, cep = EXCLUDED.cep,
          loja = EXCLUDED.loja, bloqueado_protheus = EXCLUDED.bloqueado_protheus,
          contato_email = COALESCE(tab_qf_fornecedor.contato_email, EXCLUDED.contato_email),
          contato_telefone = COALESCE(tab_qf_fornecedor.contato_telefone, EXCLUDED.contato_telefone),
          contato_nome = COALESCE(tab_qf_fornecedor.contato_nome, EXCLUDED.contato_nome)`,
      { rows: JSON.stringify(linhas.slice(i, i + 1000).map(s => ({ ...s, razao_social: s.razao_social.slice(0, 200) }))), u: u.id });
  }
  const [depois] = await Pg.connectAndQuery(`SELECT COUNT(*)::int n FROM tab_qf_fornecedor`);
  const incluidos = depois.n - antes.n;
  await log(Pg, req, { entidade: 'importacao', acao: 'SINCRONIZAR_SA2', mudancas: [{ campo: 'lidos_sa2', para: linhas.length }, { campo: 'incluidos', para: incluidos }] });
  return { lidosProtheus: linhas.length, incluidos, atualizados: linhas.length - incluidos };
}

module.exports = {
  PERM, NIVEL, BASE_URL, mw, usuario, ipDe, permsDoUsuario, temNivel, niveisDoUsuario,
  tx, diff, log, fmtValor,
  regraAtiva, regraPorId, config,
  notificar, suspender, avisarBloqueio, aplicarAcoesClasse, recalcularFornecedor, ncsAnteriores, proximoRelInsp,
  itemCriticidade, desempenho12m,
  tiposDocumento, checklistFornecedor, situacaoDocsCriticos,
  lerSA2, buscarSA2, mapSA2, sincronizarSA2,
  verificarSenha, sha256, falha, trim, nul, r4, STATUS_ATIVOS, TIPOS_PLANO
};

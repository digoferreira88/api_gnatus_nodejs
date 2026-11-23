// scripts/pipefy-clientes-duplicados.js — acha e corrige registros DUPLICADOS na
// database CLIENTES do Pipefy (tzFdhr7Y) criados pelo espelho SA1 -> Pipefy.
//
// Causa: o robô só conhecia o que o SEED de 22/09 achou e o que ele mesmo criou;
// registro feito à mão no Pipefy depois disso era invisível e o robô criava outro
// com o mesmo CÓDIGO (ex.: 171270). A prevenção está em services/pipefyClientes.js
// (buscarExistente). Este script limpa o que já duplicou.
//
// Uso (na VPS, em /home/intranet/backend):
//   node scripts/pipefy-clientes-duplicados.js
//       DIAGNÓSTICO, só leitura. Lê a database inteira (~1 requisição por 50
//       registros), agrupa por CÓDIGO, confere os cards ligados a cada registro
//       duplicado e grava o plano em scripts/_out/pipefy-clientes-duplicados.{json,csv}.
//   node scripts/pipefy-clientes-duplicados.js --aplicar [--limite N]
//       Executa SÓ os grupos marcados "auto" no plano (robô × manual, sem conflito
//       de cards): deixa o registro que fica com os dados do Protheus, aponta o
//       estado para ele e apaga o outro. Reconfere cada grupo antes de mexer.
//
// Regra do "auto" (1 registro do robô + 1 manual com o mesmo código):
//   - fica o registro MANUAL (é o que o time conhece e pode ter campos extras);
//   - exceção: se só o do robô tem cards ligados, fica o do robô e sai o manual;
//   - os dois com cards, mais de 2 registros, cards desconhecidos, ou cadastro
//     incompleto no SA1 -> "revisar" (vai para o CSV, ninguém apaga).
// Duplicado entre dois registros manuais (sem o robô) não é tocado: só é listado.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Pg = require('../services/pg');
const Protheus = require('../services/protheus');
const Metrica = require('../services/pipefyMetrica');
const PC = require('../services/pipefyClientes');

const ARGS = process.argv.slice(2);
const APLICAR = ARGS.includes('--aplicar');
const LIMITE = (() => { const i = ARGS.indexOf('--limite'); const n = i >= 0 ? parseInt(ARGS[i + 1], 10) : NaN; return Number.isFinite(n) && n > 0 ? n : Infinity; })();
const OUT_DIR = path.join(__dirname, '_out');
const OUT_JSON = path.join(OUT_DIR, 'pipefy-clientes-duplicados.json');
const OUT_CSV = path.join(OUT_DIR, 'pipefy-clientes-duplicados.csv');
const DATA_SEED = '2026-09-22';          // robô passou a criar a partir daqui
const CAMPOS_ESPELHO = new Set(Object.values(PC.F));

const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// gql do serviço (conta no tab_pipefy_uso como 'clientes') + nova tentativa em falha transitória
async function gql(q, v, tentativas = 4) {
  for (let i = 1; ; i++) {
    try { return await PC.gql(q, v); } catch (e) {
      const transit = /HTTP (429|5\d\d)|abort|ECONN|ETIMEDOUT|fetch failed/i.test(e.message);
      if (!transit || i >= tentativas) throw e;
      await sleep(2000 * i);
    }
  }
}

// ---------- introspecção: como chegar nos cards ligados a um registro ----------
const T = `fragment T on __Type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }`;
const base = (t) => { while (t && !t.name && t.ofType) t = t.ofType; return t && t.name; };
async function tipo(nome) {
  const d = await gql(`query($n: String!) { __type(name: $n) { name kind
    fields { name args { name type { ...T } } type { ...T } }
    inputFields { name type { ...T } }
    possibleTypes { name } } } ${T}`, { n: nome });
  return d.__type;
}
async function descobrirSelecaoCards() {
  const info = { ok: false, motivo: '', selecao: '' };
  try {
    const rel = await tipo('TableRecordRelation');
    const fRepo = (rel?.fields || []).find(f => f.name === 'repo_items');
    if (!fRepo) { info.motivo = 'TableRecordRelation sem repo_items'; return info; }
    const conn = await tipo(base(fRepo.type));
    const fEdges = (conn?.fields || []).find(f => f.name === 'edges');
    const fNodes = (conn?.fields || []).find(f => f.name === 'nodes');
    let nodeTipo = null; let caminho = '';
    if (fEdges) {
      const edge = await tipo(base(fEdges.type));
      const fNode = (edge?.fields || []).find(f => f.name === 'node');
      nodeTipo = fNode && base(fNode.type); caminho = 'edges { node { %s } }';
    } else if (fNodes) { nodeTipo = base(fNodes.type); caminho = 'nodes { %s }'; }
    if (!nodeTipo) { info.motivo = `conexão ${base(fRepo.type)} sem edges/nodes`; return info; }
    const nt = await tipo(nodeTipo);
    const possiveis = (nt?.possibleTypes || []).map(p => p.name);
    const temCard = nodeTipo === 'Card' || possiveis.includes('Card');
    if (!temCard) { info.motivo = `nó ${nodeTipo} não inclui Card (${possiveis.join(',')})`; return info; }
    const sel = nodeTipo === 'Card' ? '__typename id title' : '__typename ... on Card { id title }';
    const obrigArgs = (fRepo.args || []).filter(a => a.type.kind === 'NON_NULL').map(a => a.name);
    if (obrigArgs.length) { info.motivo = `repo_items exige argumentos: ${obrigArgs.join(',')}`; return info; }
    info.ok = true;
    info.selecao = `parent_relations { name source_type repo_items { ${caminho.replace('%s', sel)} } }`;
    return info;
  } catch (e) { info.motivo = e.message; return info; }
}
function contarCards(rec) {
  const cards = [];
  for (const r of rec.parent_relations || []) {
    const ri = r.repo_items || {};
    const nodes = ri.nodes || (ri.edges || []).map(e => e.node);
    for (const nd of nodes || []) if (nd && nd.__typename === 'Card') cards.push({ id: nd.id, title: nd.title, relacao: r.name });
  }
  return cards;
}
// lê os vínculos de vários registros numa requisição (aliases), 20 por vez
async function vinculos(ids, selecao) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 20) {
    const fatia = ids.slice(i, i + 20);
    const corpo = fatia.map((id, k) => `r${k}: table_record(id: "${String(id).replace(/[^0-9A-Za-z_-]/g, '')}") { id ${selecao} }`).join('\n');
    try {
      const d = await gql(`query { ${corpo} }`, {});
      fatia.forEach((id, k) => {
        const rec = d[`r${k}`];
        out.set(String(id), rec ? { existe: true, cards: contarCards(rec) } : { existe: false, cards: [] });
      });
    } catch (e) {
      fatia.forEach(id => out.set(String(id), { existe: null, cards: null, erro: e.message }));
    }
  }
  return out;
}

// ---------- leitura completa da database ----------
async function lerDatabase() {
  const todos = [];
  let after = null; let pag = 0;
  do {
    const d = await gql(`query($id: ID!, $a: String) {
      table_records(table_id: $id, first: 50, after: $a) {
        pageInfo { hasNextPage endCursor }
        edges { node { id title created_at updated_at created_by { id name } record_fields { value field { id } } } } } }`,
      { id: PC.TABLE_ID(), a: after });
    for (const e of d.table_records?.edges || []) {
      const nd = e.node;
      const campos = {};
      for (const f of nd.record_fields || []) if (f.field) campos[f.field.id] = trim(f.value);
      todos.push({ id: trim(nd.id), title: trim(nd.title), criadoEm: nd.created_at, atualizadoEm: nd.updated_at,
        criadoPorId: trim(nd.created_by?.id), criadoPor: trim(nd.created_by?.name), campos });
    }
    after = d.table_records?.pageInfo?.hasNextPage ? d.table_records.pageInfo.endCursor : null;
    if (++pag % 50 === 0) console.log(`  ... ${todos.length} registros lidos`);
  } while (after);
  return todos;
}

const csv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

// ---------- DIAGNÓSTICO ----------
async function diagnostico() {
  const me = (await gql(`{ me { id name } }`, {})).me;
  console.log(`Token do Pipefy pertence a: ${me.name} (${me.id})`);

  const selCards = await descobrirSelecaoCards();
  console.log(selCards.ok ? `Vínculos com cards: ${selCards.selecao}` : `⚠️ Vínculos com cards NÃO descobertos: ${selCards.motivo}`);

  console.log('Lendo a database inteira do Pipefy...');
  const regs = await lerDatabase();
  console.log(`  ${regs.length} registros`);

  const estado = new Map((await Pg.connectAndQuery(
    `SELECT codigo, record_id, status FROM tab_pipefy_clientes_sync`, {})).map(r => [trim(r.codigo), { recordId: trim(r.record_id), status: trim(r.status) }]));
  const sa1 = new Map((await PC.carregarSA1(Protheus)).map(PC.normalizar).map(n => [n.codigo, n]));

  const porCodigo = new Map();
  for (const r of regs) {
    const cod = trim(r.campos[PC.F.codigo]);
    if (!cod) continue;
    if (!porCodigo.has(cod)) porCodigo.set(cod, []);
    porCodigo.get(cod).push(r);
  }
  const grupos = [...porCodigo.entries()].filter(([, rs]) => rs.length > 1);
  console.log(`  ${grupos.length} códigos com mais de 1 registro`);

  // registro do robô = criado pelo dono do token depois do go-live
  const doRobo = (r) => r.criadoPorId === trim(me.id) && String(r.criadoEm || '') >= DATA_SEED;

  let vinc = new Map();
  if (selCards.ok) {
    const ids = grupos.flatMap(([, rs]) => rs.map(r => r.id));
    console.log(`Conferindo cards ligados a ${ids.length} registros duplicados...`);
    vinc = await vinculos(ids, selCards.selecao);
  }

  const plano = [];
  for (const [cod, rs] of grupos) {
    const st = estado.get(cod) || null;
    const n = sa1.get(cod) || null;
    const itens = rs.map(r => {
      const v = vinc.get(r.id);
      const extras = Object.entries(r.campos).filter(([k, val]) => val && !CAMPOS_ESPELHO.has(k)).map(([k]) => k);
      return { id: r.id, robo: doRobo(r), noEstado: !!(st && st.recordId === r.id), criadoPor: r.criadoPor,
        criadoEm: r.criadoEm, atualizadoEm: r.atualizadoEm, nome: r.campos[PC.F.nome] || '', fantasia: r.campos[PC.F.fantasia] || '',
        cgc: r.campos[PC.F.cgc] || '', cards: v ? (v.cards ? v.cards.length : null) : null,
        cardsIds: v && v.cards ? v.cards.map(c => c.id) : [], camposExtras: extras };
    });
    const robos = itens.filter(i => i.robo);
    const manuais = itens.filter(i => !i.robo);
    let acao = 'revisar'; let motivo = ''; let fica = null; let sai = null;
    if (!robos.length) motivo = 'duplicado entre registros manuais (o robô não criou nenhum)';
    else if (robos.length > 1) motivo = 'o robô criou mais de um registro para o código';
    else if (manuais.length > 1) motivo = 'mais de um registro manual para o código';
    else if (!robos[0].noEstado) motivo = 'o estado do espelho aponta para outro registro';
    else if (!n) motivo = 'código não está mais no SA1';
    else if (robos[0].cards == null || manuais[0].cards == null) motivo = 'não foi possível ler os cards ligados';
    else if (robos[0].cards > 0 && manuais[0].cards > 0) motivo = 'os dois registros têm cards ligados';
    else if (robos[0].camposExtras.length) motivo = `registro do robô tem campos preenchidos à mão (${robos[0].camposExtras.join(',')})`;
    else if (robos[0].cards > 0 && manuais[0].camposExtras.length) motivo = `só o do robô tem cards, mas o manual tem campos extras (${manuais[0].camposExtras.join(',')})`;
    else if (robos[0].cards > 0) { acao = 'auto'; fica = robos[0].id; sai = manuais[0].id; motivo = 'só o registro do robô tem cards'; }
    else if (PC.faltantes(n).length) motivo = `cadastro incompleto no SA1 (${PC.faltantes(n).join(',')}) — não dá para atualizar o manual`;
    else { acao = 'auto'; fica = manuais[0].id; sai = robos[0].id; motivo = manuais[0].cards > 0 ? 'manual tem cards; sai o do robô' : 'fica o manual; sai o do robô'; }
    plano.push({ codigo: cod, nomeSA1: n ? n.nome : '', acao, motivo, fica, sai, estado: st, registros: itens });
  }

  // possíveis duplicados SEM código: mesmo CPF/CNPJ de um código já espelhado
  const docsEspelhados = new Map();
  for (const n of sa1.values()) { const st = estado.get(n.codigo); if (st && st.recordId && soDig(n.cgc)) docsEspelhados.set(soDig(n.cgc), n.codigo); }
  const semCodigo = regs.filter(r => !trim(r.campos[PC.F.codigo]))
    .map(r => ({ r, doc: soDig(r.campos[PC.F.cgc] || r.title) }))
    .filter(x => x.doc && docsEspelhados.has(x.doc))
    .map(x => ({ id: x.r.id, title: x.r.title, criadoPor: x.r.criadoPor, criadoEm: x.r.criadoEm, codigoProvavel: docsEspelhados.get(x.doc) }));

  const res = {
    geradoEm: new Date().toISOString(), tabela: PC.TABLE_ID(), tokenDe: me, vinculos: selCards,
    totais: { registros: regs.length, gruposDuplicados: plano.length,
      auto: plano.filter(p => p.acao === 'auto').length, revisar: plano.filter(p => p.acao === 'revisar').length,
      roboXManual: plano.filter(p => p.registros.some(i => i.robo) && p.registros.some(i => !i.robo)).length,
      soManuais: plano.filter(p => !p.registros.some(i => i.robo)).length, semCodigoMesmoDoc: semCodigo.length },
    plano, semCodigo
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(res, null, 2));
  const linhas = [['codigo', 'nome_sa1', 'acao', 'motivo', 'registro', 'url', 'robo', 'criado_por', 'criado_em', 'cards', 'nome_no_pipefy', 'fantasia_no_pipefy', 'destino'].map(csv).join(';')];
  for (const p of plano) for (const i of p.registros) {
    const destino = p.acao !== 'auto' ? '' : i.id === p.fica ? 'FICA' : i.id === p.sai ? 'APAGA' : '';
    linhas.push([p.codigo, p.nomeSA1, p.acao, p.motivo, i.id, `https://app.pipefy.com/database_v2/tables/${PC.TABLE_ID()}/records/${i.id}`,
      i.robo ? 'sim' : 'não', i.criadoPor, i.criadoEm, i.cards == null ? '?' : i.cards, i.nome, i.fantasia, destino].map(csv).join(';'));
  }
  fs.writeFileSync(OUT_CSV, '﻿' + linhas.join('\r\n'));

  const ex = plano.find(p => p.codigo === '171270');
  if (ex) console.log('Exemplo 171270:', JSON.stringify(ex, null, 2));
  console.log('Totais:', JSON.stringify(res.totais));
  const porMotivo = {};
  plano.forEach(p => { const k = `${p.acao}: ${p.motivo.replace(/\(.*\)/, '').trim()}`; porMotivo[k] = (porMotivo[k] || 0) + 1; });
  console.log('Por motivo:', JSON.stringify(porMotivo, null, 2));
  console.log(`Plano: ${OUT_JSON}\nCSV:   ${OUT_CSV}`);
}

// ---------- APLICAR ----------
async function aplicar() {
  if (!fs.existsSync(OUT_JSON)) throw new Error(`rode o diagnóstico antes (${OUT_JSON} não existe)`);
  const res = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
  if (!res.vinculos?.ok) throw new Error('o diagnóstico não conseguiu ler os cards ligados; nada a aplicar');
  const del = await tipo('DeleteTableRecordInput');
  if (!(del?.inputFields || []).some(f => f.name === 'id')) throw new Error('DeleteTableRecordInput sem campo id');

  const sa1 = new Map((await PC.carregarSA1(Protheus)).map(PC.normalizar).map(n => [n.codigo, n]));
  const fila = res.plano.filter(p => p.acao === 'auto').slice(0, LIMITE);
  console.log(`Aplicando ${fila.length} grupo(s)...`);
  const r = { ok: 0, pulados: 0, erros: 0, detalhes: [] };
  for (const p of fila) {
    try {
      // reconfere: os dois ainda existem e quem sai continua sem cards
      const v = await vinculos([p.fica, p.sai], res.vinculos.selecao);
      const vf = v.get(String(p.fica)); const vs = v.get(String(p.sai));
      if (!vf?.existe || vs?.existe === false) { r.pulados++; r.detalhes.push(`${p.codigo}: registro sumiu (fica=${vf?.existe} sai=${vs?.existe})`); continue; }
      if (vs.cards == null || vs.cards.length > 0) { r.pulados++; r.detalhes.push(`${p.codigo}: quem sairia ganhou card ligado`); continue; }
      const n = sa1.get(p.codigo);
      if (!n || PC.faltantes(n).length) { r.pulados++; r.detalhes.push(`${p.codigo}: SA1 ausente/incompleto`); continue; }

      if (p.fica !== p.estado?.recordId) {                         // fica o manual: recebe os dados do Protheus
        await PC.atualizarRegistro(p.fica, n);
        await PC.gravarEstado(Pg, p.codigo, p.fica, PC.hashCli(n), 'ok');
      }
      const d = await gql(`mutation($i: DeleteTableRecordInput!) { deleteTableRecord(input: $i) { success } }`, { i: { id: p.sai } });
      if (!d.deleteTableRecord?.success) throw new Error('deleteTableRecord sem success');
      r.ok++;
      r.detalhes.push(`${p.codigo}: fica ${p.fica}, apagado ${p.sai}`);
    } catch (e) {
      r.erros++; r.detalhes.push(`${p.codigo}: ERRO ${e.message}`);
      console.warn(`  ${p.codigo}: ${e.message}`);
      if (r.erros > 5) { console.error('Mais de 5 erros — parando.'); break; }
    }
  }
  await Pg.connectAndQuery(
    `INSERT INTO tab_pipefy_clientes_log (origem, atualizados, erros, detalhe) VALUES ('DEDUP', @a, @e, @d)`,
    { a: r.ok, e: r.erros, d: r.detalhes.slice(0, 40).join(' | ').slice(0, 1900) }).catch(() => {});
  console.log(JSON.stringify({ ok: r.ok, pulados: r.pulados, erros: r.erros }, null, 2));
  r.detalhes.forEach(l => console.log('  ' + l));
}

(async () => {
  const t0 = Date.now();
  try {
    if (APLICAR) await aplicar(); else await diagnostico();
  } catch (e) {
    console.error('Falhou:', e.message);
    process.exitCode = 1;
  } finally {
    await Metrica.flush({ Pg }).catch(() => {});   // chamadas entram no tab_pipefy_uso
    console.log(`(${Math.round((Date.now() - t0) / 1000)} s)`);
    process.exit();
  }
})();

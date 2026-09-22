// services/pipefyClientes.js — Espelho do cadastro de clientes do Protheus (SA1)
// na database "CLIENTES" do Pipefy (id tzFdhr7Y). Cada cliente novo no Protheus
// vira registro no Pipefy; mudança em dado monitorado atualiza o registro.
//
// Padrão idêntico ao pipefyOp.js (GraphQL + tab_pipefy_uso), com uma tabela de
// ESTADO em Postgres (tab_pipefy_clientes_sync) que guarda o record_id + hash de
// cada código -> o diff SA1 × Pipefy é feito em Postgres e SÓ O DELTA vai à API.
//
// Config (.env):
//   PIPEFY_TOKEN            (obrigatório — sem ele o serviço fica dormente)
//   PIPEFY_CLIENTES_ATIVO   '1' liga o espelho (nasce '0' = desligado)
//   PIPEFY_CLIENTES_ATUALIZAR '1' (padrão) espelha mudanças; '0' = só inserir novos
//   PIPEFY_TABELA_CLIENTES  id da database CLIENTES (padrão 'tzFdhr7Y')
//   PIPEFY_CLIENTES_TETO_DIA   máx. gravações/dia (padrão 250) — trava do backfill
//   PIPEFY_CLIENTES_TETO_CICLO máx. gravações por execução (padrão 60)
//
// Fluxo de go-live: 1) SEED (uma vez) pagina o Pipefy e registra quem já existe lá;
// 2) o cron passa a criar os que faltam (mais novos primeiro), represado pelo teto.

const crypto = require('crypto');
const Metrica = require('./pipefyMetrica');

const TOKEN = () => String(process.env.PIPEFY_TOKEN || '').trim();
const TABLE_ID = () => String(process.env.PIPEFY_TABELA_CLIENTES || 'tzFdhr7Y').trim();
const ATIVO = () => String(process.env.PIPEFY_CLIENTES_ATIVO || '0') === '1';
const ATUALIZAR = () => String(process.env.PIPEFY_CLIENTES_ATUALIZAR || '1') === '1';
const disponivel = () => !!TOKEN() && ATIVO();

const intEnv = (k, def) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) && n >= 0 ? n : def; };
const TETO_DIA = () => intEnv('PIPEFY_CLIENTES_TETO_DIA', 250);
const TETO_CICLO = () => intEnv('PIPEFY_CLIENTES_TETO_CICLO', 60);

const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

// ---------- Campos da database CLIENTES no Pipefy (ids descobertos via GraphQL) ----------
const F = {
  codigo: 'c_digo', nome: 'nome', fantasia: 'nome_fantasia', pessoa: 'f_sica_jur_dica',
  cgc: 'cpf_cnpj', end: 'endere_o', bairro: 'bairro', cidade: 'cidade', estado: 'estado',
  cep: 'cep', telefone: 'telefone', email: 'e_mail_1'
};

// ---------- GraphQL ----------
async function gql(query, variables) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    Metrica.contar('clientes');   // consumo do contrato do Pipefy (tab_pipefy_uso)
    const r = await fetch('https://api.pipefy.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN()}` },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.errors) {
      const msg = j.errors ? j.errors.map(e => e.message).join('; ') : `HTTP ${r.status}`;
      throw new Error(`Pipefy: ${msg}`);
    }
    return j.data;
  } catch (e) { clearTimeout(timer); throw e; }
}

// ---------- SA1 (1 linha por código; loja menor = matriz '01' quando existe) ----------
const SQL_SA1 = `
  WITH cli AS (
    SELECT
      RTRIM(A1_COD) cod, RTRIM(A1_LOJA) loja, RTRIM(A1_NOME) nome, RTRIM(A1_NREDUZ) fantasia,
      RTRIM(A1_PESSOA) pessoa, RTRIM(A1_CGC) cgc, RTRIM(A1_END) endereco, RTRIM(A1_BAIRRO) bairro,
      RTRIM(A1_MUN) cidade, RTRIM(A1_EST) estado, RTRIM(A1_CEP) cep,
      RTRIM(A1_DDD) ddd, RTRIM(A1_DDDCEL) dddcel, RTRIM(A1_TEL) tel, RTRIM(A1_EMAIL) email,
      RTRIM(ISNULL(A1_MSBLQL,'')) bloqueado,
      ROW_NUMBER() OVER (PARTITION BY RTRIM(A1_COD) ORDER BY A1_LOJA) rn
    FROM SA1010 WITH (NOLOCK)
    WHERE D_E_L_E_T_ <> '*' AND A1_FILIAL = '01'
  )
  SELECT cod, loja, nome, fantasia, pessoa, cgc, endereco, bairro, cidade, estado,
         cep, ddd, dddcel, tel, email, bloqueado
    FROM cli WHERE rn = 1`;

async function carregarSA1(Protheus) {
  return Protheus.connectAndQuery(SQL_SA1, {});
}

// ---------- Normalização / formatação (canônica: alimenta valor E hash) ----------
function fmtDoc(cgc) {
  const d = soDig(cgc);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return trim(cgc);
}
function fmtCep(cep) {
  const d = soDig(cep);
  return d.length === 8 ? d.replace(/(\d{5})(\d{3})/, '$1-$2') : trim(cep);
}
function fmtTel(ddd, tel) {
  const dd = soDig(ddd).replace(/^0+/, '');
  const t = soDig(tel);
  if (!t) return '';
  const num = t.length === 8 ? t.replace(/(\d{4})(\d{4})/, '$1-$2')
            : t.length === 9 ? t.replace(/(\d{5})(\d{4})/, '$1-$2')
            : t;
  return dd ? `+55 ${dd} ${num}` : num;
}
function fmtPessoa(p) {
  const c = trim(p).toUpperCase();
  return c === 'F' ? 'FISICA' : c === 'J' ? 'JURIDICA' : c;
}

function normalizar(row) {
  const ddd = trim(row.ddd) || trim(row.dddcel);
  return {
    codigo: trim(row.cod),
    nome: trim(row.nome),
    fantasia: trim(row.fantasia) || trim(row.nome),
    pessoa: fmtPessoa(row.pessoa),
    cgc: fmtDoc(row.cgc),
    end: trim(row.endereco),
    bairro: trim(row.bairro),
    cidade: trim(row.cidade),
    estado: trim(row.estado),
    cep: fmtCep(row.cep),
    telefone: fmtTel(ddd, row.tel),
    email: trim(row.email)
  };
}

function hashCli(n) {
  const s = [n.nome, n.fantasia, n.pessoa, n.cgc, n.end, n.bairro, n.cidade, n.estado, n.cep, n.telefone, n.email].join('');
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

// Campos OBRIGATÓRIOS na database CLIENTES do Pipefy (todos marcados * — testado:
// a API rejeita create/update com qualquer um vazio, inclusive o phone com "").
// Espelhamos só quem tem todos preenchidos no SA1; o resto é reportado p/ o cadastro
// completar no Protheus (aí entra sozinho no ciclo seguinte) — sem dado falso.
const OBRIGATORIOS = ['nome', 'fantasia', 'pessoa', 'cgc', 'end', 'bairro', 'cidade', 'estado', 'cep', 'telefone', 'email'];
const ROTULO = { nome: 'NOME', fantasia: 'NOME FANTASIA', pessoa: 'FÍSICA/JURÍDICA', cgc: 'CPF/CNPJ',
  end: 'ENDEREÇO', bairro: 'BAIRRO', cidade: 'CIDADE', estado: 'ESTADO', cep: 'CEP', telefone: 'TELEFONE', email: 'E-MAIL' };
function faltantes(n) { return OBRIGATORIOS.filter(k => !trim(n[k])); }

function montarCampos(n) {
  return [
    { field_id: F.codigo, field_value: n.codigo },
    { field_id: F.nome, field_value: n.nome },
    { field_id: F.fantasia, field_value: n.fantasia },
    { field_id: F.pessoa, field_value: n.pessoa },
    { field_id: F.cgc, field_value: n.cgc },
    { field_id: F.end, field_value: n.end },
    { field_id: F.bairro, field_value: n.bairro },
    { field_id: F.cidade, field_value: n.cidade },
    { field_id: F.estado, field_value: n.estado },
    { field_id: F.cep, field_value: n.cep },
    { field_id: F.telefone, field_value: n.telefone },
    { field_id: F.email, field_value: n.email }
  ];
}

async function criarRegistro(n) {
  const d = await gql(`mutation($input: CreateTableRecordInput!) {
    createTableRecord(input: $input) { table_record { id } } }`,
    { input: { table_id: TABLE_ID(), title: n.cgc || n.codigo, fields_attributes: montarCampos(n) } });
  return trim(d.createTableRecord?.table_record?.id);
}

async function atualizarRegistro(recordId, n) {
  // 1 chamada (batch) p/ todos os campos — nodeId genérico serve p/ table_record.
  const values = montarCampos(n).map(f => ({ fieldId: f.field_id, value: f.field_value }));
  await gql(`mutation($input: UpdateFieldsValuesInput!) {
    updateFieldsValues(input: $input) { success } }`,
    { input: { nodeId: recordId, values } });
}

// ---------- Estado (Postgres) ----------
async function carregarEstado(Pg) {
  const rows = await Pg.connectAndQuery(`SELECT codigo, record_id, hash, status FROM tab_pipefy_clientes_sync`, {});
  const m = new Map();
  rows.forEach(r => m.set(trim(r.codigo), { recordId: trim(r.record_id), hash: trim(r.hash), status: trim(r.status) }));
  return m;
}
async function gravarEstado(Pg, codigo, recordId, hash, status, erro = null) {
  await Pg.connectAndQuery(
    `INSERT INTO tab_pipefy_clientes_sync (codigo, record_id, hash, status, erro, atualizado_em)
     VALUES (@c, @r, @h, @s, @e, NOW())
     ON CONFLICT (codigo) DO UPDATE
        SET record_id = COALESCE(EXCLUDED.record_id, tab_pipefy_clientes_sync.record_id),
            hash = EXCLUDED.hash, status = EXCLUDED.status, erro = EXCLUDED.erro, atualizado_em = NOW()`,
    { c: codigo, r: recordId || null, h: hash || null, s: status, e: erro });
}
async function marcarErro(Pg, codigo, msg) {
  try {
    await Pg.connectAndQuery(
      `INSERT INTO tab_pipefy_clientes_sync (codigo, status, erro, atualizado_em)
       VALUES (@c, 'erro', @e, NOW())
       ON CONFLICT (codigo) DO UPDATE SET status = 'erro', erro = EXCLUDED.erro, atualizado_em = NOW()`,
      { c: codigo, e: String(msg).slice(0, 400) });
  } catch (_) { /* best-effort */ }
}

async function usoHoje(Pg) {
  const r = await Pg.connectAndQuery(
    `SELECT COALESCE(gravacoes, 0)::int g FROM tab_pipefy_clientes_ctrl WHERE dia = @d::date`, { d: hojeSP() });
  return Number(r[0]?.g || 0);
}
async function somarUso(Pg, n) {
  if (n <= 0) return;
  await Pg.connectAndQuery(
    `INSERT INTO tab_pipefy_clientes_ctrl (dia, gravacoes) VALUES (@d::date, @n)
     ON CONFLICT (dia) DO UPDATE SET gravacoes = tab_pipefy_clientes_ctrl.gravacoes + EXCLUDED.gravacoes`,
    { d: hojeSP(), n });
}
async function logar(Pg, r) {
  try {
    await Pg.connectAndQuery(
      `INSERT INTO tab_pipefy_clientes_log (origem, sa1, criados, atualizados, erros, faltando_antes, detalhe)
       VALUES (@o, @sa1, @c, @a, @e, @f, @d)`,
      { o: r.origem, sa1: r.sa1, c: r.criados, a: r.atualizados, e: r.erros,
        f: r.faltandoAntes || 0, d: r.detalhes.slice(0, 25).join(' | ').slice(0, 1900) });
  } catch (e) { console.warn('[pipefy-clientes] log:', e.message); }
}

// ---------- SEED (uma vez): registra quem já existe na database do Pipefy ----------
// Pagina a table CLIENTES e casa por CÓDIGO. Para os códigos que também estão no
// SA1, grava o hash canônico como BASELINE (assim o espelho NÃO reescreve os 11 mil
// que já existiam — só mudanças futuras disparam update). Código no Pipefy sem SA1
// vira 'orfao' (deixado como está — espelho é aditivo).
async function seed({ Pg, Protheus }) {
  const resumo = { origem: 'SEED', lidos: 0, comCodigo: 0, dups: 0, comSA1: 0, orfaos: 0 };
  if (!TOKEN()) { resumo.erro = 'PIPEFY_TOKEN ausente'; return resumo; }

  const sa1 = (await carregarSA1(Protheus)).map(normalizar);
  const hashByCod = new Map();
  sa1.forEach(n => hashByCod.set(n.codigo, hashCli(n)));

  const vistos = new Set();
  let after = null;
  do {
    const d = await gql(`query($id: ID!, $a: String) {
      table_records(table_id: $id, first: 50, after: $a) {
        pageInfo { hasNextPage endCursor }
        edges { node { id record_fields { name value } } } } }`, { id: TABLE_ID(), a: after });
    for (const e of (d.table_records?.edges || [])) {
      resumo.lidos++;
      const f = e.node.record_fields.find(x => /c.?digo/i.test(x.name)); // "CÓDIGO:"
      const cod = f ? trim(f.value) : '';
      if (!cod) continue;
      resumo.comCodigo++;
      if (vistos.has(cod)) { resumo.dups++; continue; }
      vistos.add(cod);
      const h = hashByCod.get(cod);       // undefined = existe no Pipefy e não no SA1
      const status = h ? 'seed' : 'orfao';
      if (h) resumo.comSA1++; else resumo.orfaos++;
      await gravarEstado(Pg, cod, trim(e.node.id), h || null, status);
    }
    after = d.table_records?.pageInfo?.hasNextPage ? d.table_records.pageInfo.endCursor : null;
  } while (after);

  await Pg.connectAndQuery(
    `INSERT INTO tab_pipefy_clientes_log (origem, sa1, detalhe)
     VALUES ('SEED', @sa1, @d)`,
    { sa1: sa1.length, d: `lidos=${resumo.lidos} comCodigo=${resumo.comCodigo} comSA1=${resumo.comSA1} orfaos=${resumo.orfaos} dups=${resumo.dups}` }).catch(() => {});
  console.log('[pipefy-clientes] seed:', JSON.stringify(resumo));
  return resumo;
}

// ---------- Sincronização (delta, represada pelo teto) ----------
async function sincronizar({ Pg, Protheus }, origem = 'CRON') {
  const resumo = { origem, sa1: 0, criados: 0, atualizados: 0, semMudanca: 0, erros: 0,
    faltandoAntes: 0, aAtualizar: 0, incompletos: 0, puladosCap: 0, teto: TETO_DIA(), usoHoje: 0, detalhes: [] };

  if (!disponivel()) {
    resumo.detalhes.push('inativo (defina PIPEFY_TOKEN e PIPEFY_CLIENTES_ATIVO=1)');
    return resumo;
  }

  // trava anti-duplicata: sem SEED, não sabemos quem já existe no Pipefy
  const est0 = (await Pg.connectAndQuery(`SELECT COUNT(*)::int n FROM tab_pipefy_clientes_sync`, {}))[0];
  if (!Number(est0.n)) {
    resumo.seedPendente = true;
    resumo.detalhes.push('estado vazio — rode o SEED antes (evita recriar registro duplicado).');
    await logar(Pg, resumo);
    return resumo;
  }

  // orçamento do ciclo = min(teto ciclo, folga do dia)
  resumo.usoHoje = await usoHoje(Pg);
  const orcamento = Math.min(TETO_CICLO(), Math.max(0, TETO_DIA() - resumo.usoHoje));
  if (orcamento <= 0) {
    resumo.detalhes.push(`teto diário atingido (${TETO_DIA()} gravações) — retoma amanhã.`);
    await logar(Pg, resumo);
    return resumo;
  }

  const sa1 = (await carregarSA1(Protheus));
  resumo.sa1 = sa1.length;
  const estado = await carregarEstado(Pg);

  // mais NOVOS primeiro (código desc) — cliente recém-cadastrado não espera o backfill
  const norm = sa1.map(normalizar).sort((a, b) => (a.codigo < b.codigo ? 1 : a.codigo > b.codigo ? -1 : 0));

  const toCreate = [];
  const toUpdate = [];
  for (const n of norm) {
    const st = estado.get(n.codigo);
    const incompleto = faltantes(n).length > 0;   // Pipefy rejeita obrigatório vazio
    if (!st || !st.recordId) {
      if (incompleto) { resumo.incompletos++; continue; }  // fica p/ o cadastro completar
      toCreate.push(n);
      continue;
    }
    if (st.status === 'orfao') continue;
    if (ATUALIZAR() && st.hash && st.hash !== hashCli(n)) {
      if (incompleto) { resumo.incompletos++; continue; }  // não reescreve p/ valor inválido
      toUpdate.push({ n, recordId: st.recordId });
    } else resumo.semMudanca++;
  }
  resumo.faltandoAntes = toCreate.length;
  resumo.aAtualizar = toUpdate.length;

  let gravou = 0;
  for (const n of toCreate) {
    if (gravou >= orcamento) { resumo.puladosCap++; continue; }
    try {
      const recId = await criarRegistro(n);
      await gravarEstado(Pg, n.codigo, recId, hashCli(n), 'ok');
      resumo.criados++; gravou++;
    } catch (e) {
      resumo.erros++; resumo.detalhes.push(`cria ${n.codigo}: ${e.message}`);
      await marcarErro(Pg, n.codigo, e.message);
    }
  }
  for (const u of toUpdate) {
    if (gravou >= orcamento) { resumo.puladosCap++; continue; }
    try {
      await atualizarRegistro(u.recordId, u.n);
      await gravarEstado(Pg, u.n.codigo, u.recordId, hashCli(u.n), 'ok');
      resumo.atualizados++; gravou++;
    } catch (e) {
      resumo.erros++; resumo.detalhes.push(`upd ${u.n.codigo}: ${e.message}`);
      await marcarErro(Pg, u.n.codigo, e.message);
    }
  }

  await somarUso(Pg, gravou);
  await logar(Pg, resumo);
  console.log(`[pipefy-clientes] ${origem}: sa1=${resumo.sa1} faltavam=${resumo.faltandoAntes} criados=${resumo.criados} atualizados=${resumo.atualizados} incompletos=${resumo.incompletos} erros=${resumo.erros} puladosCap=${resumo.puladosCap} (uso dia ${resumo.usoHoje + gravou}/${TETO_DIA()})`);
  return resumo;
}

// ---------- Panorama p/ a tela de status ----------
// Conta SA1: total de códigos distintos + quantos estão COMPLETOS (todos os campos
// obrigatórios do Pipefy preenchidos). O incompleto não é espelhável até o cadastro
// completar. Uma query só (a de completude é a mesma do diagnóstico).
async function contarSA1(Protheus) {
  const r = (await Protheus.connectAndQuery(`
    WITH cli AS (
      SELECT RTRIM(A1_CGC) cgc, RTRIM(A1_END) endr, RTRIM(A1_BAIRRO) bairro, RTRIM(A1_MUN) mun,
             RTRIM(A1_EST) est, RTRIM(A1_CEP) cep, RTRIM(A1_TEL) tel, RTRIM(A1_EMAIL) email,
             RTRIM(A1_NOME) nome, RTRIM(A1_PESSOA) pessoa,
             ROW_NUMBER() OVER (PARTITION BY RTRIM(A1_COD) ORDER BY A1_LOJA) rn
        FROM SA1010 WITH (NOLOCK) WHERE D_E_L_E_T_ <> '*' AND A1_FILIAL='01')
    SELECT COUNT(*) total,
      SUM(CASE WHEN cgc<>'' AND endr<>'' AND bairro<>'' AND mun<>'' AND est<>'' AND cep<>''
                AND tel<>'' AND email<>'' AND nome<>'' AND pessoa<>'' THEN 1 ELSE 0 END) completos
      FROM cli WHERE rn=1`, {}))[0];
  return { total: Number(r?.total || 0), completos: Number(r?.completos || 0) };
}

async function panorama({ Pg, Protheus }) {
  const sa1 = await contarSA1(Protheus);
  const st = (await Pg.connectAndQuery(
    `SELECT
       COUNT(*) FILTER (WHERE record_id IS NOT NULL AND status <> 'orfao')::int sincronizados,
       COUNT(*) FILTER (WHERE status = 'orfao')::int orfaos,
       COUNT(*) FILTER (WHERE status = 'erro')::int erros,
       COUNT(*)::int total
     FROM tab_pipefy_clientes_sync`, {}))[0];
  const sincronizados = Number(st?.sincronizados || 0);
  return {
    ativo: disponivel(),
    atualizar: ATUALIZAR(),
    tabelaPipefy: TABLE_ID(),
    tetoDia: TETO_DIA(),
    tetoCiclo: TETO_CICLO(),
    usoHoje: await usoHoje(Pg),
    seedFeito: Number(st?.total || 0) > 0,
    totais: {
      sa1: sa1.total,
      completos: sa1.completos,
      incompletos: Math.max(0, sa1.total - sa1.completos),
      sincronizados,
      faltando: Math.max(0, sa1.completos - sincronizados),
      orfaos: Number(st?.orfaos || 0),
      erros: Number(st?.erros || 0)
    }
  };
}

// Lista os clientes do SA1 que NÃO podem ser espelhados por faltar campo obrigatório
// (saída acionável p/ o cadastro corrigir no Protheus). Limitado p/ não pesar.
async function listarIncompletos({ Protheus }, limite = 500) {
  const rows = await carregarSA1(Protheus);
  const out = [];
  for (const r of rows) {
    const n = normalizar(r);
    const falt = faltantes(n);
    if (falt.length) {
      out.push({ codigo: n.codigo, nome: n.nome, faltando: falt.map(k => ROTULO[k]) });
      if (out.length >= limite) break;
    }
  }
  return out;
}

async function ultimosLogs(Pg, limite = 15) {
  return Pg.connectAndQuery(
    `SELECT origem, sa1, criados, atualizados, erros, faltando_antes, detalhe,
            TO_CHAR(criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') quando
       FROM tab_pipefy_clientes_log ORDER BY criado_em DESC LIMIT @l`, { l: limite });
}

module.exports = {
  disponivel, sincronizar, seed, panorama, ultimosLogs, listarIncompletos,
  // expostos p/ teste/auditoria
  normalizar, hashCli, montarCampos, faltantes, carregarSA1, TABLE_ID, ATUALIZAR
};

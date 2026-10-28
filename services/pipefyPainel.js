// services/pipefyPainel.js — snapshot org-wide do Pipefy pro Painel de Gestão à
// Vista (TVs). Varre os pipes CONSIDERADOS da organização e agrega os cards
// ABERTOS (fases done ficam de fora): atrasados, responsáveis, SETORES,
// gargalos, aging.
//
// CONFIG NO BANCO (migration 97, tela /gerencia/painel-vista/config):
//   tab_painel_pipe          pipe considerar true/false (sem linha = considera —
//                            pipe novo entra sozinho no painel)
//   tab_painel_usuario_setor responsável (nome do assignee) -> setor
//   tab_painel_setor         setores da empresa (seed fixo)
// A visão "setores com maior índice de atraso" atribui cada card aberto ao(s)
// setor(es) dos seus responsáveis; sem responsável ou sem vínculo cai em
// "(SEM SETOR)" — aparece no painel de propósito, pra forçar o cadastro.
//
// CACHE EM MEMÓRIA com TTL (default 5 min) + single-flight; a tela de config
// invalida o cache ao salvar (invalidarCache) pro painel refletir rápido.
//
// "Atrasado" = card.late OU card.expired OU due_date < agora (o Pipefy marca
// late/expired pelo SLA da fase mesmo sem due_date).
//
// Config (.env): PIPEFY_TOKEN, PAINEL_PIPEFY_EXCLUIR (CSV extra de pipe ids,
// além da tabela), PAINEL_PIPEFY_TTL_MIN (default 5).

const Metrica = require('./pipefyMetrica');
const trim = (v) => String(v == null ? '' : v).trim();

const TOKEN = () => trim(process.env.PIPEFY_TOKEN);
const ORG_ID = () => trim(process.env.PIPEFY_ORG_ID || '301239355');
const TTL_MS = () => Math.max(1, Number(process.env.PAINEL_PIPEFY_TTL_MIN || 5)) * 60000;
const EXCLUIR_ENV = () => new Set(
  (process.env.PAINEL_PIPEFY_EXCLUIR || '').split(',').map(s => trim(s)).filter(Boolean)
);

const disponivel = () => !!TOKEN();

async function gql(query, variables) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    Metrica.contar('painel');   // consumo do contrato do Pipefy (tab_pipefy_uso)
    const r = await fetch('https://api.pipefy.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN()}` },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.errors) {
      throw new Error(`Pipefy: ${j.errors ? j.errors.map(e => e.message).join('; ') : `HTTP ${r.status}`}`);
    }
    return j.data;
  } catch (e) { clearTimeout(timer); throw e; }
}

// Lista leve de pipes da org (pra config e pro sweep): id, nome, abertos estimados
async function listarPipesOrg() {
  const d = await gql(`query($org: ID!) { organization(id: $org) {
    pipes { id name phases { done cards_count } } } }`, { org: ORG_ID() });
  return (d.organization?.pipes || []).map(p => ({
    id: trim(p.id), nome: trim(p.name),
    abertosEstimados: p.phases.filter(f => !f.done).reduce((s, f) => s + (f.cards_count || 0), 0)
  }));
}

// Config do banco (tolerante a migration 97 ausente)
async function lerConfig(Pg) {
  const cfg = { pipesDesconsiderados: new Set(), setorPorUsuario: new Map() };
  if (!Pg) return cfg;
  try {
    const rows = await Pg.connectAndQuery(
      `SELECT pipe_id FROM tab_painel_pipe WHERE NOT considerar`, {});
    rows.forEach(r => cfg.pipesDesconsiderados.add(trim(r.pipe_id)));
  } catch (e) { console.warn('[pipefy-painel] tab_painel_pipe indisponivel (migration 97?):', e.message); }
  try {
    const rows = await Pg.connectAndQuery(`
      SELECT u.usuario_nome, s.nome setor
        FROM tab_painel_usuario_setor u
        JOIN tab_painel_setor s ON s.id = u.setor_id`, {});
    rows.forEach(r => cfg.setorPorUsuario.set(trim(r.usuario_nome), trim(r.setor)));
  } catch (e) { console.warn('[pipefy-painel] tab_painel_usuario_setor indisponivel:', e.message); }
  return cfg;
}

const CARD_FIELDS_BASE = `id title due_date late expired createdAt assignees { name } current_phase { name }`;
// updated_at / current_phase_age alimentam "dias na fase" e "sem movimento" da
// Visão Executiva. Pedir campo a mais NÃO custa requisição. Se o Pipefy recusar
// algum deles, cai pro BASE e segue (a tela esconde o que depende deles).
const CARD_FIELDS_EXT = `${CARD_FIELDS_BASE} updated_at current_phase_age`;
let camposExt = true;
const CARD_FIELDS = () => (camposExt ? CARD_FIELDS_EXT : CARD_FIELDS_BASE);

// Cards abertos de um pipe: 1 request pega as primeiras 50 de cada fase;
// pagina só as fases que passarem disso.
async function cardsAbertosDoPipe(pipe) {
  const cards = [];
  const d = await gql(`query($id: ID!) { pipe(id: $id) { phases {
    id name done cards_count
    cards(first: 50) { pageInfo { hasNextPage endCursor } edges { node { ${CARD_FIELDS()} } } }
  } } }`, { id: pipe.id });

  for (const fase of (d.pipe?.phases || [])) {
    if (fase.done) continue;
    let edges = fase.cards?.edges || [];
    let pageInfo = fase.cards?.pageInfo;
    edges.forEach(e => cards.push({ ...e.node, fase: fase.name }));
    while (pageInfo?.hasNextPage) {
      const pg = await gql(`query($f: ID!, $a: String) { phase(id: $f) {
        cards(first: 50, after: $a) { pageInfo { hasNextPage endCursor } edges { node { ${CARD_FIELDS()} } } }
      } }`, { f: fase.id, a: pageInfo.endCursor });
      edges = pg.phase?.cards?.edges || [];
      edges.forEach(e => cards.push({ ...e.node, fase: fase.name }));
      pageInfo = pg.phase?.cards?.pageInfo;
    }
  }
  return cards;
}

function montarSnapshot(pipesBrutos, cfg) {
  const agora = Date.now();
  const DIA = 864e5;
  const dias = (iso) => (iso ? Math.floor((agora - new Date(iso).getTime()) / DIA) : null);

  const pipes = [];
  const topAtrasados = [];
  const todosCards = [];
  const porResp = new Map();
  const porSetor = new Map();
  const setorDe = (nome) => cfg.setorPorUsuario.get(nome) || null;
  let totalAbertos = 0, totalAtrasados = 0, semResponsavel = 0, maisAntigoGeral = null;

  const addSetor = (setor, atrasado) => {
    if (!porSetor.has(setor)) porSetor.set(setor, { setor, total: 0, atrasados: 0 });
    const s = porSetor.get(setor);
    s.total++; if (atrasado) s.atrasados++;
  };

  for (const p of pipesBrutos) {
    const porFase = new Map();
    let atrasados = 0, somaIdade = 0, maisAntigo = null;

    for (const c of p.cards) {
      const vencido = c.due_date ? new Date(c.due_date).getTime() < agora : false;
      const atrasado = c.late === true || c.expired === true || vencido;
      const idadeDias = dias(c.createdAt) ?? 0;
      const diasAtraso = vencido ? dias(c.due_date) : null;
      somaIdade += idadeDias;
      if (atrasado) atrasados++;
      porFase.set(c.fase, (porFase.get(c.fase) || 0) + 1);
      if (!maisAntigo || idadeDias > maisAntigo.idadeDias) {
        maisAntigo = { titulo: trim(c.title).slice(0, 60), idadeDias };
      }

      const nomes = (c.assignees || []).map(a => trim(a.name)).filter(Boolean);
      if (!nomes.length) semResponsavel++;
      nomes.forEach(n => {
        if (!porResp.has(n)) porResp.set(n, { nome: n, total: 0, atrasados: 0, setor: setorDe(n) });
        const r = porResp.get(n);
        r.total++; if (atrasado) r.atrasados++;
      });

      // Card conta 1x por setor distinto dos responsáveis; sem vínculo = (SEM SETOR)
      const setores = [...new Set(nomes.map(setorDe).filter(Boolean))];
      if (setores.length) setores.forEach(s => addSetor(s, atrasado));
      else addSetor('(SEM SETOR)', atrasado);

      if (atrasado) {
        topAtrasados.push({
          pipe: p.nome, titulo: trim(c.title).slice(0, 60), fase: trim(c.fase),
          responsaveis: nomes.slice(0, 2), diasAtraso, idadeDias
        });
      }

      // Lista enxuta (chaves curtas: ~1.500 cards) — a Visão Executiva filtra e
      // agrega no navegador. A rota da TV tira este campo da resposta.
      todosCards.push({
        id: trim(c.id), p: p.id, t: trim(c.title).slice(0, 80), f: trim(c.fase),
        r: nomes, a: atrasado ? 1 : 0, v: diasAtraso, i: idadeDias,
        fa: c.current_phase_age != null ? Math.floor(Number(c.current_phase_age) / 86400) : null,
        u: c.updated_at ? dias(c.updated_at) : null
      });
    }

    totalAbertos += p.cards.length;
    totalAtrasados += atrasados;
    if (maisAntigo && (!maisAntigoGeral || maisAntigo.idadeDias > maisAntigoGeral.idadeDias)) {
      maisAntigoGeral = { ...maisAntigo, pipe: p.nome };
    }
    const gargalo = [...porFase.entries()].sort((a, b) => b[1] - a[1])[0];
    pipes.push({
      id: p.id, nome: p.nome,
      abertos: p.cards.length, atrasados,
      pctAtrasados: p.cards.length ? Math.round(atrasados / p.cards.length * 100) : 0,
      mediaIdadeDias: p.cards.length ? Math.round(somaIdade / p.cards.length) : 0,
      faseGargalo: gargalo ? { nome: gargalo[0], qtd: gargalo[1] } : null,
      maisAntigo
    });
  }

  topAtrasados.sort((a, b) => (b.diasAtraso ?? -1) - (a.diasAtraso ?? -1) || b.idadeDias - a.idadeDias);
  pipes.sort((a, b) => b.abertos - a.abertos);

  // Índice de atraso por setor (o "(SEM SETOR)" fica por último no empate de pct
  // não — ordena por pct desc; ele aparece onde o índice mandar)
  const setores = [...porSetor.values()]
    .map(s => ({ ...s, pctAtraso: s.total ? Math.round(s.atrasados / s.total * 100) : 0 }))
    .sort((a, b) => b.pctAtraso - a.pctAtraso || b.atrasados - a.atrasados);

  const responsaveis = [...porResp.values()].sort((a, b) => b.atrasados - a.atrasados || b.total - a.total);

  return {
    geradoEm: new Date().toISOString(),
    totais: {
      pipes: pipes.length,
      abertos: totalAbertos,
      atrasados: totalAtrasados,
      pctNoPrazo: totalAbertos ? Math.round((totalAbertos - totalAtrasados) / totalAbertos * 100) : 100,
      semResponsavel,
      maisAntigo: maisAntigoGeral
    },
    pipes,
    topAtrasados: topAtrasados.slice(0, 20),
    porSetor: setores,
    porResponsavel: responsaveis.slice(0, 15),
    // Universo completo (tela de config usa pra listar todo mundo)
    responsaveis,
    // --- só Visão Executiva (a rota da TV remove) ---
    cards: todosCards,
    setorPorResp: Object.fromEntries(cfg.setorPorUsuario),
    camposExt,
    pipesComErro: pipesBrutos.filter(p => p.erro).map(p => p.nome)
  };
}

// ---------- histórico diário (migration 137) ----------
// Uma linha por dia × (total | pipe | setor); a última leitura do dia vence.
// Ciclo com pipe falhando NÃO grava — o pipe viria zerado e a série cairia à toa.
async function gravarHistorico(Pg, snap) {
  if (!Pg || snap.pipesComErro.length) return;
  const nomePipe = new Map(snap.pipes.map(p => [p.id, p.nome]));
  const acc = new Map();
  const somar = (tipo, chave, nome, c) => {
    const k = `${tipo}|${chave}`;
    if (!acc.has(k)) acc.set(k, { tipo, chave, nome, abertos: 0, atrasados: 0, mais90: 0 });
    const a = acc.get(k);
    a.abertos++; if (c.a) a.atrasados++; if (c.i > 90) a.mais90++;
  };
  snap.pipes.forEach(p => acc.set(`pipe|${p.id}`, { tipo: 'pipe', chave: p.id, nome: p.nome, abertos: 0, atrasados: 0, mais90: 0 }));
  for (const c of snap.cards) {
    somar('total', '*', 'TOTAL', c);
    somar('pipe', c.p, nomePipe.get(c.p), c);
    const setores = [...new Set(c.r.map(n => snap.setorPorResp[n]).filter(Boolean))];
    (setores.length ? setores : ['(SEM SETOR)']).forEach(s => somar('setor', s, s, c));
  }
  if (!acc.has('total|*')) acc.set('total|*', { tipo: 'total', chave: '*', nome: 'TOTAL', abertos: 0, atrasados: 0, mais90: 0 });

  const params = {};
  const values = [...acc.values()].map((r, i) => {
    Object.assign(params, {
      [`t${i}`]: r.tipo, [`c${i}`]: String(r.chave).slice(0, 80), [`n${i}`]: String(r.nome || '').slice(0, 120),
      [`a${i}`]: r.abertos, [`x${i}`]: r.atrasados, [`m${i}`]: r.mais90
    });
    return `((NOW() AT TIME ZONE 'America/Sao_Paulo')::date, @t${i}, @c${i}, @n${i}, @a${i}, @x${i}, @m${i}, NOW())`;
  });
  await Pg.connectAndQuery(`
    INSERT INTO tab_painel_historico (dia, tipo, chave, nome, abertos, atrasados, mais_90d, atualizado_em)
    VALUES ${values.join(',\n')}
    ON CONFLICT (dia, tipo, chave) DO UPDATE SET
      nome = EXCLUDED.nome, abertos = EXCLUDED.abertos, atrasados = EXCLUDED.atrasados,
      mais_90d = EXCLUDED.mais_90d, atualizado_em = NOW()`, params);
}

// Série dos últimos N dias (Visão Executiva). Tolerante à migration 137 ausente.
async function lerHistorico(Pg, dias = 120) {
  try {
    const rows = await Pg.connectAndQuery(`
      SELECT to_char(dia, 'YYYY-MM-DD') dia, tipo, chave, abertos, atrasados, mais_90d
        FROM tab_painel_historico
       WHERE dia >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date - @dias::int
       ORDER BY dia`, { dias });
    return rows.map(r => ({
      dia: r.dia, tipo: trim(r.tipo), chave: trim(r.chave),
      abertos: Number(r.abertos), atrasados: Number(r.atrasados), mais90: Number(r.mais_90d)
    }));
  } catch (e) {
    console.warn('[pipefy-painel] tab_painel_historico indisponivel (migration 137?):', e.message);
    return [];
  }
}

// ---------- cache single-flight ----------
let cache = null;
let construindo = null;

async function construir(Pg) {
  const cfg = await lerConfig(Pg);
  const excluirEnv = EXCLUIR_ENV();
  const todos = await listarPipesOrg();
  const alvos = todos.filter(p => !excluirEnv.has(p.id) && !cfg.pipesDesconsiderados.has(p.id));

  const pipesBrutos = [];
  for (const alvo of alvos) {
    if (alvo.abertosEstimados === 0) { pipesBrutos.push({ ...alvo, cards: [] }); continue; }
    try {
      pipesBrutos.push({ ...alvo, cards: await cardsAbertosDoPipe(alvo) });
    } catch (e) {
      // Pipefy recusou updated_at/current_phase_age: desliga os extras e repete o pipe
      if (camposExt && /updated_at|current_phase_age/i.test(e.message)) {
        camposExt = false;
        console.warn(`[pipefy-painel] campos extras recusados (${e.message}) — seguindo sem "dias na fase"`);
        try { pipesBrutos.push({ ...alvo, cards: await cardsAbertosDoPipe(alvo) }); continue; }
        catch (e2) { e = e2; }
      }
      console.warn(`[pipefy-painel] pipe ${alvo.nome} falhou (${e.message}) — segue sem ele neste ciclo`);
      pipesBrutos.push({ ...alvo, cards: [], erro: true });
    }
  }
  const snap = montarSnapshot(pipesBrutos, cfg);
  gravarHistorico(Pg, snap).catch(e =>
    console.warn('[pipefy-painel] historico nao gravado (migration 137?):', e.message));
  return snap;
}

// Snapshot vigente (cache + single-flight); em falha serve o último bom.
async function obterSnapshot(Pg) {
  const fresco = cache && (Date.now() - new Date(cache.geradoEm).getTime()) < TTL_MS();
  if (fresco) return cache;
  if (!construindo) {
    construindo = construir(Pg)
      .then(s => { cache = s; return s; })
      .finally(() => { construindo = null; });
  }
  try {
    return await construindo;
  } catch (e) {
    if (cache) return { ...cache, desatualizado: true, erroAtualizacao: e.message };
    throw e;
  }
}

// Tela de config salva -> derruba o cache pro próximo GET refletir na hora
function invalidarCache() { cache = null; }

// Resposta da TV: sem os campos pesados da Visão Executiva
function paraTv(snap) {
  const { cards, setorPorResp, camposExt: _c, pipesComErro, ...resto } = snap;
  return resto;
}

module.exports = { disponivel, obterSnapshot, listarPipesOrg, invalidarCache, lerHistorico, paraTv };

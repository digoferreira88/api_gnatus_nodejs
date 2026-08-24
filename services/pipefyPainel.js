// services/pipefyPainel.js — snapshot org-wide do Pipefy pro Painel de Gestão à
// Vista (TVs). Varre TODOS os pipes da organização e agrega os cards ABERTOS
// (fases done ficam de fora): atrasados, responsáveis, gargalos, aging.
//
// CACHE EM MEMÓRIA com TTL (default 5 min) + single-flight: as TVs consultam à
// vontade e o Pipefy só é varrido quando o snapshot venceu (a varredura completa
// é ~35 requests GraphQL p/ ~1.300 cards — medido 19/08). pm2 roda 1 instância,
// então o cache é efetivamente global.
//
// "Atrasado" = card.late OU card.expired OU due_date < agora. O Pipefy marca
// late/expired pelo SLA da fase mesmo sem due_date — os três sinais contam.
//
// Config (.env): PIPEFY_TOKEN (mesmo dos outros módulos),
//   PAINEL_PIPEFY_EXCLUIR   CSV de pipe ids fora do painel (default: pipe de teste)
//   PAINEL_PIPEFY_TTL_MIN   validade do snapshot em minutos (default 5)

const trim = (v) => String(v == null ? '' : v).trim();

const TOKEN = () => trim(process.env.PIPEFY_TOKEN);
const ORG_ID = () => trim(process.env.PIPEFY_ORG_ID || '301239355');
const TTL_MS = () => Math.max(1, Number(process.env.PAINEL_PIPEFY_TTL_MIN || 5)) * 60000;
const EXCLUIR = () => new Set(
  (process.env.PAINEL_PIPEFY_EXCLUIR || '306929743').split(',').map(s => trim(s)).filter(Boolean)
);

const disponivel = () => !!TOKEN();

async function gql(query, variables) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
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

const CARD_FIELDS = `id title due_date late expired createdAt assignees { name } current_phase { name }`;

// Cards abertos de um pipe: 1 request pega as primeiras 50 de cada fase;
// pagina só as fases que passarem disso.
async function cardsAbertosDoPipe(pipe) {
  const cards = [];
  const d = await gql(`query($id: ID!) { pipe(id: $id) { phases {
    id name done cards_count
    cards(first: 50) { pageInfo { hasNextPage endCursor } edges { node { ${CARD_FIELDS} } } }
  } } }`, { id: pipe.id });

  for (const fase of (d.pipe?.phases || [])) {
    if (fase.done) continue;
    let edges = fase.cards?.edges || [];
    let pageInfo = fase.cards?.pageInfo;
    edges.forEach(e => cards.push({ ...e.node, fase: fase.name }));
    while (pageInfo?.hasNextPage) {
      const pg = await gql(`query($f: ID!, $a: String) { phase(id: $f) {
        cards(first: 50, after: $a) { pageInfo { hasNextPage endCursor } edges { node { ${CARD_FIELDS} } } }
      } }`, { f: fase.id, a: pageInfo.endCursor });
      edges = pg.phase?.cards?.edges || [];
      edges.forEach(e => cards.push({ ...e.node, fase: fase.name }));
      pageInfo = pg.phase?.cards?.pageInfo;
    }
  }
  return cards;
}

function montarSnapshot(pipesBrutos) {
  const agora = Date.now();
  const DIA = 864e5;
  const dias = (iso) => (iso ? Math.floor((agora - new Date(iso).getTime()) / DIA) : null);

  const pipes = [];
  const topAtrasados = [];
  const porResp = new Map();
  let totalAbertos = 0, totalAtrasados = 0, semResponsavel = 0, maisAntigoGeral = null;

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
        if (!porResp.has(n)) porResp.set(n, { nome: n, total: 0, atrasados: 0 });
        const r = porResp.get(n);
        r.total++; if (atrasado) r.atrasados++;
      });

      if (atrasado) {
        topAtrasados.push({
          pipe: p.nome, titulo: trim(c.title).slice(0, 60), fase: trim(c.fase),
          responsaveis: nomes.slice(0, 2), diasAtraso, idadeDias
        });
      }
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

  // Ordena: atraso conhecido em dias primeiro (desc), depois idade
  topAtrasados.sort((a, b) => (b.diasAtraso ?? -1) - (a.diasAtraso ?? -1) || b.idadeDias - a.idadeDias);
  pipes.sort((a, b) => b.abertos - a.abertos);

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
    porResponsavel: [...porResp.values()].sort((a, b) => b.atrasados - a.atrasados || b.total - a.total).slice(0, 15)
  };
}

// ---------- cache single-flight ----------
let cache = null;          // último snapshot bom
let construindo = null;    // promise em voo (single-flight)

async function construir() {
  const d = await gql(`query($org: ID!) { organization(id: $org) {
    pipes { id name phases { done cards_count } } } }`, { org: ORG_ID() });
  const excluir = EXCLUIR();
  const alvos = (d.organization?.pipes || [])
    .filter(p => !excluir.has(trim(p.id)))
    .map(p => ({
      id: trim(p.id), nome: trim(p.name),
      abertosEstimados: p.phases.filter(f => !f.done).reduce((s, f) => s + (f.cards_count || 0), 0)
    }));

  const pipesBrutos = [];
  for (const alvo of alvos) {
    if (alvo.abertosEstimados === 0) { pipesBrutos.push({ ...alvo, cards: [] }); continue; }
    try {
      pipesBrutos.push({ ...alvo, cards: await cardsAbertosDoPipe(alvo) });
    } catch (e) {
      console.warn(`[pipefy-painel] pipe ${alvo.nome} falhou (${e.message}) — segue sem ele neste ciclo`);
      pipesBrutos.push({ ...alvo, cards: [], erro: true });
    }
  }
  return montarSnapshot(pipesBrutos);
}

// Snapshot vigente. Se venceu, reconstrói (single-flight); se a reconstrução
// falhar e houver snapshot velho, serve o velho com flag `desatualizado`.
async function obterSnapshot() {
  const fresco = cache && (Date.now() - new Date(cache.geradoEm).getTime()) < TTL_MS();
  if (fresco) return cache;
  if (!construindo) {
    construindo = construir()
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

module.exports = { disponivel, obterSnapshot };

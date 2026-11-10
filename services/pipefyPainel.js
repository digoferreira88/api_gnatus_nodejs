// services/pipefyPainel.js — Painel de Gestão à Vista (TVs + Visão Executiva).
// Agrega os cards ABERTOS dos pipes CONSIDERADOS da organização (fases done
// ficam de fora): atrasados, responsáveis, SETORES, gargalos, aging.
//
// ESPELHO NO BANCO (migration 142) — o Pipefy é lido em horários fixos, não a
// cada vez que alguém abre a tela:
//   sincronizar()   chamado pelo scheduler (job "painel-pipefy", padrão 06h, 12h e 18h
//                   seg-sex). Lê a lista de pipes da org + os cards
//                   abertos de cada pipe considerado e grava em
//                   tab_painel_pipefy_pipe / tab_painel_pipefy_card. Cada leitura
//                   fica em tab_painel_pipefy_sync com o custo em chamadas.
//   obterSnapshot() o que as telas usam. Monta o retrato a partir do BANCO (zero
//                   chamada ao Pipefy). Idades e "vencido pela data" são contadas
//                   na hora; late/expired valem como estavam na última leitura.
//   Espelho vazio (1º acesso depois do deploy): obterSnapshot faz UMA leitura.
//   Pipe que falha numa leitura mantém os cards da leitura anterior.
//
// CONFIG NO BANCO (migration 97, tela /gerencia/painel-vista/config):
//   tab_painel_pipe          pipe considerar true/false (sem linha = considera —
//                            pipe novo entra sozinho no painel)
//   tab_painel_usuario_setor responsável (nome do assignee) -> setor
//   tab_painel_setor         setores da empresa (seed fixo)
// Desmarcar um pipe vale na hora (filtro na leitura); marcar dispara a leitura
// só daquele pipe (lerPipeAgora). Card sem responsável ou sem vínculo cai em
// "(SEM SETOR)" — aparece no painel de propósito, pra forçar o cadastro.
//
// Situação do card (campo `s`, Visão Executiva):
//   2 vencido          card.expired (vencimento do pipe) OU due_date < agora
//   1 atrasado na fase card.late (passou do SLA da fase)
//   0 no prazo
// "Atrasado" (campo `a`, TV e histórico) = situação 1 ou 2.
//
// GERENTES DOS SETORES (migration 146): vêm da database GESTORES do Pipefy (nome,
// e-mail, WhatsApp). Espelhada em tab_painel_gestor a cada leitura completa
// (+1 chamada por página de 50) e pelo botão da tela de config; o vínculo
// setor -> gestor fica em tab_painel_setor_gestor.
//
// Config (.env): PIPEFY_TOKEN, PAINEL_PIPEFY_EXCLUIR (CSV extra de pipe ids,
// além da tabela), PIPEFY_TABELA_GESTORES (padrão ri_r5xI5). Cron em
// services/scheduler.js (CRON_PAINEL_PIPEFY).

const Metrica = require('./pipefyMetrica');
const trim = (v) => String(v == null ? '' : v).trim();

const TOKEN = () => trim(process.env.PIPEFY_TOKEN);
const ORG_ID = () => trim(process.env.PIPEFY_ORG_ID || '301239355');
const EXCLUIR_ENV = () => new Set(
  (process.env.PAINEL_PIPEFY_EXCLUIR || '').split(',').map(s => trim(s)).filter(Boolean)
);

const TABELA_GESTORES = () => trim(process.env.PIPEFY_TABELA_GESTORES || 'ri_r5xI5');

const disponivel = () => !!TOKEN();

// `cont` (opcional) soma as chamadas de uma leitura, pra gravar o custo dela
async function gql(query, variables, cont) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    Metrica.contar('painel');   // consumo do contrato do Pipefy (tab_pipefy_uso)
    if (cont) cont.n++;
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

// Lista leve de pipes da org: id, nome, abertos estimados (1 chamada)
async function listarPipesOrg(cont) {
  const d = await gql(`query($org: ID!) { organization(id: $org) {
    pipes { id name phases { done cards_count } } } }`, { org: ORG_ID() }, cont);
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
async function cardsAbertosDoPipe(pipe, cont) {
  const cards = [];
  const d = await gql(`query($id: ID!) { pipe(id: $id) { phases {
    id name done cards_count
    cards(first: 50) { pageInfo { hasNextPage endCursor } edges { node { ${CARD_FIELDS()} } } }
  } } }`, { id: pipe.id }, cont);

  for (const fase of (d.pipe?.phases || [])) {
    if (fase.done) continue;
    let edges = fase.cards?.edges || [];
    let pageInfo = fase.cards?.pageInfo;
    edges.forEach(e => cards.push({ ...e.node, fase: fase.name }));
    while (pageInfo?.hasNextPage) {
      const pg = await gql(`query($f: ID!, $a: String) { phase(id: $f) {
        cards(first: 50, after: $a) { pageInfo { hasNextPage endCursor } edges { node { ${CARD_FIELDS()} } } }
      } }`, { f: fase.id, a: pageInfo.endCursor }, cont);
      edges = pg.phase?.cards?.edges || [];
      edges.forEach(e => cards.push({ ...e.node, fase: fase.name }));
      pageInfo = pg.phase?.cards?.pageInfo;
    }
  }
  return cards;
}

// Lê os cards do pipe; se o Pipefy recusar updated_at/current_phase_age, desliga
// os extras e repete uma vez.
async function cardsComFallback(pipe, cont) {
  try {
    return await cardsAbertosDoPipe(pipe, cont);
  } catch (e) {
    if (camposExt && /updated_at|current_phase_age/i.test(e.message)) {
      camposExt = false;
      console.warn(`[pipefy-painel] campos extras recusados (${e.message}) — seguindo sem "dias na fase"`);
      return cardsAbertosDoPipe(pipe, cont);
    }
    throw e;
  }
}

function montarSnapshot(pipesBrutos, cfg, ext) {
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
      const vencidoData = c.due_date ? new Date(c.due_date).getTime() < agora : false;
      const situacao = (c.expired === true || vencidoData) ? 2 : c.late === true ? 1 : 0;
      const atrasado = situacao > 0;
      const idadeDias = dias(c.createdAt) ?? 0;
      const diasAtraso = vencidoData ? dias(c.due_date) : null;
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
        r: nomes, a: atrasado ? 1 : 0, s: situacao, v: diasAtraso, i: idadeDias,
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
    camposExt: ext,
    pipesComErro: pipesBrutos.filter(p => p.erro).map(p => p.nome)
  };
}

// ---------- histórico diário (migration 137) ----------
// Uma linha por dia × (total | pipe | setor); a última leitura do dia vence.
// Gravado a cada leitura do Pipefy (sincronizar), então todo dia útil ganha ponto.
// Leitura com pipe falhando NÃO grava — o pipe viria com dado velho e a série
// ficaria torta.
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

// ---------- espelho: gravação (migration 142) ----------

async function gravarPipesOrg(Pg, pipes) {
  const dados = JSON.stringify(pipes.map(p => ({ id: p.id, nome: p.nome.slice(0, 160), abertos: p.abertosEstimados })));
  await Pg.connectAndQuery(`
    INSERT INTO tab_painel_pipefy_pipe (pipe_id, nome, abertos_estimados, lido_em)
    SELECT x.id, x.nome, x.abertos, NOW()
      FROM jsonb_to_recordset(@dados::jsonb) AS x(id text, nome text, abertos int)
    ON CONFLICT (pipe_id) DO UPDATE SET
      nome = EXCLUDED.nome, abertos_estimados = EXCLUDED.abertos_estimados, lido_em = NOW()`, { dados });
  // pipe que sumiu da organização (excluído no Pipefy) sai do espelho
  await Pg.connectAndQuery(
    `DELETE FROM tab_painel_pipefy_pipe WHERE NOT (pipe_id = ANY(@ids::text[]))`, { ids: pipes.map(p => p.id) });
}

// Troca os cards do pipe pelos recém-lidos, numa transação (quem lê no meio vê
// a versão anterior inteira, nunca metade).
async function gravarCardsDoPipe(Pg, pipeId, cards, lidoEm) {
  const unicos = new Map();
  cards.forEach(c => unicos.set(trim(c.id), c));   // paginação pode repetir card que mudou de lugar
  const linhas = [...unicos.values()].map(c => ({
    id: trim(c.id),
    titulo: trim(c.title).slice(0, 300),
    fase: trim(c.fase).slice(0, 200),
    resp: (c.assignees || []).map(a => trim(a.name)).filter(Boolean),
    late: c.late === true,
    expired: c.expired === true,
    due: c.due_date || null,
    criado: c.createdAt || null,
    atualizado: c.updated_at || null,
    fase_desde: c.current_phase_age != null
      ? new Date(lidoEm.getTime() - Number(c.current_phase_age) * 1000).toISOString() : null
  }));
  await Pg.withTransaction(async (cli) => {
    await cli.query('DELETE FROM tab_painel_pipefy_card WHERE pipe_id = $1', [pipeId]);
    if (linhas.length) {
      await cli.query(`
        INSERT INTO tab_painel_pipefy_card
          (card_id, pipe_id, titulo, fase, responsaveis, atrasado_fase, vencido_pipe,
           vencimento, criado_em, atualizado_em, na_fase_desde, lido_em)
        SELECT x.id, $1, x.titulo, x.fase,
               ARRAY(SELECT jsonb_array_elements_text(COALESCE(x.resp, '[]'::jsonb))),
               x.late, x.expired, x.due, x.criado, x.atualizado, x.fase_desde, $3
          FROM jsonb_to_recordset($2::jsonb) AS x(
               id text, titulo text, fase text, resp jsonb, late boolean, expired boolean,
               due timestamptz, criado timestamptz, atualizado timestamptz, fase_desde timestamptz)
        ON CONFLICT (card_id) DO UPDATE SET
          pipe_id = EXCLUDED.pipe_id, titulo = EXCLUDED.titulo, fase = EXCLUDED.fase,
          responsaveis = EXCLUDED.responsaveis, atrasado_fase = EXCLUDED.atrasado_fase,
          vencido_pipe = EXCLUDED.vencido_pipe, vencimento = EXCLUDED.vencimento,
          criado_em = EXCLUDED.criado_em, atualizado_em = EXCLUDED.atualizado_em,
          na_fase_desde = EXCLUDED.na_fase_desde, lido_em = EXCLUDED.lido_em`,
        [pipeId, JSON.stringify(linhas), lidoEm]);
    }
    await cli.query(
      `UPDATE tab_painel_pipefy_pipe SET cards_em = $2, erro = NULL, erro_em = NULL WHERE pipe_id = $1`,
      [pipeId, lidoEm]);
  });
  return linhas.length;
}

async function lerEGravarPipe(Pg, pipe, cont) {
  const lidoEm = new Date();
  // pipe sem card aberto (pela contagem da org) não gasta chamada
  const cards = pipe.abertosEstimados === 0 ? [] : await cardsComFallback(pipe, cont);
  return gravarCardsDoPipe(Pg, pipe.id, cards, lidoEm);
}

async function marcarErroPipe(Pg, pipeId, msg) {
  await Pg.connectAndQuery(
    `UPDATE tab_painel_pipefy_pipe SET erro = @msg, erro_em = NOW() WHERE pipe_id = @id`,
    { id: pipeId, msg: String(msg).slice(0, 500) }).catch(() => {});
}

// ---------- espelho: leitura completa (scheduler) ----------
let sincronizando = null;

// Single-flight: cron e 1º acesso ao mesmo tempo fazem UMA leitura só.
function sincronizar(Pg, origem = 'CRON') {
  if (!sincronizando) {
    sincronizando = executarSincronia(Pg, origem).finally(() => { sincronizando = null; });
  }
  return sincronizando;
}

async function executarSincronia(Pg, origem) {
  const cont = { n: 0 };
  const [{ id: syncId }] = await Pg.connectAndQuery(
    `INSERT INTO tab_painel_pipefy_sync (origem, completa) VALUES (@origem, TRUE) RETURNING id`, { origem });
  try {
    const cfg = await lerConfig(Pg);
    const excluirEnv = EXCLUIR_ENV();
    const todos = await listarPipesOrg(cont);
    await gravarPipesOrg(Pg, todos);
    const alvos = todos.filter(p => !excluirEnv.has(p.id) && !cfg.pipesDesconsiderados.has(p.id));

    const comErro = [];
    let cards = 0;
    for (const alvo of alvos) {
      try {
        cards += await lerEGravarPipe(Pg, alvo, cont);
      } catch (e) {
        console.warn(`[pipefy-painel] pipe ${alvo.nome} falhou (${e.message}) — fica com a leitura anterior`);
        comErro.push(alvo.nome);
        await marcarErroPipe(Pg, alvo.id, e.message);
      }
    }
    // cards de pipe que saiu do painel (desmarcado na config ou excluído do Pipefy)
    await Pg.connectAndQuery(
      `DELETE FROM tab_painel_pipefy_card WHERE NOT (pipe_id = ANY(@ids::text[]))`, { ids: alvos.map(p => p.id) });

    // Gestores dos setores: falha aqui não derruba a leitura do painel
    await lerGestoresPipefy(cont).then(regs => gravarGestores(Pg, regs)).catch(e =>
      console.warn('[pipefy-painel] database GESTORES nao lida:', e.message));

    await Pg.connectAndQuery(`
      UPDATE tab_painel_pipefy_sync
         SET fim = NOW(), requisicoes = @req, pipes = @pipes, cards = @cards,
             pipes_com_erro = @erros::text[], campos_ext = @ext
       WHERE id = @id`,
      { id: syncId, req: cont.n, pipes: alvos.length, cards, erros: comErro, ext: camposExt });
    invalidarCache();

    // Foto do dia para a tendência (só quando todos os pipes vieram)
    if (!comErro.length) {
      const snap = await montarDoBanco(Pg);
      await gravarHistorico(Pg, snap).catch(e =>
        console.warn('[pipefy-painel] historico nao gravado (migration 137?):', e.message));
    }
    return { requisicoes: cont.n, pipes: alvos.length, cards, pipesComErro: comErro };
  } catch (e) {
    await Pg.connectAndQuery(
      `UPDATE tab_painel_pipefy_sync SET fim = NOW(), requisicoes = @req, erro = @msg WHERE id = @id`,
      { id: syncId, req: cont.n, msg: String(e.message).slice(0, 500) }).catch(() => {});
    invalidarCache();   // a tela passa a avisar que está mostrando a leitura anterior
    throw e;
  }
}

// Tela de config marcou um pipe: lê só ele agora, pra não esperar a próxima
// leitura agendada. Custo: 1 chamada + 1 por página extra de 50 cards.
async function lerPipeAgora(Pg, pipeId, nome) {
  const cont = { n: 0 };
  const [{ id: syncId }] = await Pg.connectAndQuery(
    `INSERT INTO tab_painel_pipefy_sync (origem, completa, pipes) VALUES ('CONFIG', FALSE, 1) RETURNING id`, {});
  try {
    await Pg.connectAndQuery(`
      INSERT INTO tab_painel_pipefy_pipe (pipe_id, nome, lido_em) VALUES (@id, @nome, NOW())
      ON CONFLICT (pipe_id) DO NOTHING`, { id: pipeId, nome: trim(nome).slice(0, 160) || null });
    const cards = await lerEGravarPipe(Pg, { id: pipeId, abertosEstimados: null }, cont);
    await Pg.connectAndQuery(
      `UPDATE tab_painel_pipefy_sync SET fim = NOW(), requisicoes = @req, cards = @cards, campos_ext = @ext WHERE id = @id`,
      { id: syncId, req: cont.n, cards, ext: camposExt });
    invalidarCache();
    return { requisicoes: cont.n, cards };
  } catch (e) {
    await marcarErroPipe(Pg, pipeId, e.message);
    await Pg.connectAndQuery(
      `UPDATE tab_painel_pipefy_sync SET fim = NOW(), requisicoes = @req, erro = @msg WHERE id = @id`,
      { id: syncId, req: cont.n, msg: String(e.message).slice(0, 500) }).catch(() => {});
    throw e;
  }
}

// ---------- gestores (database GESTORES do Pipefy, migration 146) ----------

// Lê a database inteira (1 chamada por página de 50 registros)
async function lerGestoresPipefy(cont) {
  const regs = [];
  let after = null;
  do {
    const d = await gql(`query($t: ID!, $a: String) {
      table_records(table_id: $t, first: 50, after: $a) {
        pageInfo { hasNextPage endCursor }
        edges { node { id title record_fields { field { id } value } } } } }`,
      { t: TABELA_GESTORES(), a: after }, cont);
    for (const e of (d.table_records?.edges || [])) {
      const campo = (id) => trim(((e.node.record_fields || []).find(f => f.field?.id === id) || {}).value);
      regs.push({
        id: trim(e.node.id),
        nome: (campo('nome') || trim(e.node.title)).slice(0, 150),
        email: campo('e_mail').toLowerCase().slice(0, 150),
        whatsapp: campo('whatsapp').replace(/\D/g, '').slice(0, 20)
      });
    }
    after = d.table_records?.pageInfo?.hasNextPage ? d.table_records.pageInfo.endCursor : null;
  } while (after);
  return regs;
}

// Grava a leitura COMPLETA: atualiza quem veio e marca no_pipefy = FALSE em quem
// sumiu (não apaga, pra não levar junto o vínculo com o setor).
async function gravarGestores(Pg, regs) {
  await Pg.withTransaction(async (cli) => {
    if (regs.length) {
      await cli.query(`
        INSERT INTO tab_painel_gestor (record_id, nome, email, whatsapp, no_pipefy, lido_em)
        SELECT x.id, x.nome, NULLIF(x.email, ''), NULLIF(x.whatsapp, ''), TRUE, NOW()
          FROM jsonb_to_recordset($1::jsonb) AS x(id text, nome text, email text, whatsapp text)
        ON CONFLICT (record_id) DO UPDATE SET
          nome = EXCLUDED.nome, email = EXCLUDED.email, whatsapp = EXCLUDED.whatsapp,
          no_pipefy = TRUE, lido_em = NOW()`, [JSON.stringify(regs)]);
    }
    await cli.query(`UPDATE tab_painel_gestor SET no_pipefy = FALSE WHERE NOT (record_id = ANY($1::text[]))`,
      [regs.map(r => r.id)]);
  });
  return regs.length;
}

// Botão da tela de config (e 1º acesso com espelho vazio). Single-flight; o
// custo fica registrado em tab_painel_pipefy_sync (origem GESTORES).
let lendoGestores = null;
function lerGestoresAgora(Pg) {
  if (!lendoGestores) {
    lendoGestores = (async () => {
      const cont = { n: 0 };
      const [{ id: syncId }] = await Pg.connectAndQuery(
        `INSERT INTO tab_painel_pipefy_sync (origem, completa, pipes) VALUES ('GESTORES', FALSE, 0) RETURNING id`, {});
      try {
        const n = await gravarGestores(Pg, await lerGestoresPipefy(cont));
        await Pg.connectAndQuery(`UPDATE tab_painel_pipefy_sync SET fim = NOW(), requisicoes = @req WHERE id = @id`,
          { id: syncId, req: cont.n });
        return { gestores: n, requisicoes: cont.n };
      } catch (e) {
        await Pg.connectAndQuery(`UPDATE tab_painel_pipefy_sync SET fim = NOW(), requisicoes = @req, erro = @msg WHERE id = @id`,
          { id: syncId, req: cont.n, msg: String(e.message).slice(0, 500) }).catch(() => {});
        throw e;
      }
    })().finally(() => { lendoGestores = null; });
  }
  return lendoGestores;
}

// ---------- espelho: leitura pelas telas ----------

// Próxima leitura agendada (o scheduler registra o job aqui)
let agenda = null;
function definirAgenda(job) { agenda = job || null; }
function proximaLeitura() {
  try {
    const d = agenda && agenda.nextInvocation();
    if (!d) return null;
    return new Date(typeof d.getTime === 'function' ? d.getTime() : d).toISOString();
  } catch { return null; }
}

const ultimaLeitura = async (Pg, soOk) => (await Pg.connectAndQuery(`
  SELECT id, fim, erro, campos_ext FROM tab_painel_pipefy_sync
   WHERE completa AND fim IS NOT NULL ${soOk ? 'AND erro IS NULL' : ''}
   ORDER BY id DESC LIMIT 1`, {}))[0] || null;

async function montarDoBanco(Pg) {
  let ok = await ultimaLeitura(Pg, true);
  if (!ok) {
    // Espelho vazio (1º acesso depois do deploy). Lê o Pipefy uma vez — mas se a
    // última tentativa falhou há pouco, não insiste a cada clique.
    const tentativa = await ultimaLeitura(Pg, false);
    const recente = tentativa && (Date.now() - new Date(tentativa.fim).getTime()) < 10 * 60000;
    if (recente) throw new Error(`a última leitura do Pipefy falhou (${tentativa.erro})`);
    if (!disponivel()) throw new Error('PIPEFY_TOKEN não configurado no servidor.');
    await sincronizar(Pg, 'INICIAL');
    ok = await ultimaLeitura(Pg, true);
    if (!ok) throw new Error('a leitura inicial do Pipefy não terminou');
  }
  const ultima = await ultimaLeitura(Pg, false);

  const cfg = await lerConfig(Pg);
  const excluirEnv = EXCLUIR_ENV();
  const [pipes, cards] = await Promise.all([
    Pg.connectAndQuery(`SELECT pipe_id, nome, erro FROM tab_painel_pipefy_pipe`, {}),
    Pg.connectAndQuery(`
      SELECT card_id, pipe_id, titulo, fase, responsaveis, atrasado_fase, vencido_pipe,
             vencimento, criado_em, atualizado_em, na_fase_desde
        FROM tab_painel_pipefy_card`, {})
  ]);

  // Linha do banco -> mesmo formato do card do Pipefy (montarSnapshot é o mesmo)
  const agora = Date.now();
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  const porPipe = new Map();
  for (const r of cards) {
    const pid = trim(r.pipe_id);
    if (!porPipe.has(pid)) porPipe.set(pid, []);
    porPipe.get(pid).push({
      id: trim(r.card_id), title: r.titulo || '', fase: r.fase || '',
      assignees: (r.responsaveis || []).map(name => ({ name })),
      late: r.atrasado_fase === true, expired: r.vencido_pipe === true,
      due_date: iso(r.vencimento), createdAt: iso(r.criado_em), updated_at: iso(r.atualizado_em),
      current_phase_age: r.na_fase_desde ? Math.max(0, (agora - new Date(r.na_fase_desde).getTime()) / 1000) : null
    });
  }
  const pipesBrutos = pipes
    .map(p => ({ id: trim(p.pipe_id), nome: trim(p.nome), erro: !!p.erro }))
    .filter(p => !excluirEnv.has(p.id) && !cfg.pipesDesconsiderados.has(p.id))
    .map(p => ({ ...p, cards: porPipe.get(p.id) || [] }));

  const snap = montarSnapshot(pipesBrutos, cfg, ok.campos_ext !== false);
  snap.geradoEm = iso(ok.fim);              // hora em que os dados saíram do Pipefy
  snap.proximaLeitura = proximaLeitura();
  if (ultima && ultima.id !== ok.id) {
    snap.desatualizado = true;              // a última leitura falhou inteira
    snap.erroAtualizacao = ultima.erro;
  }
  return snap;
}

// Cache curto em memória: várias TVs batendo juntas não refazem a conta. O
// banco é a fonte; isto só evita remontar o mesmo retrato a cada requisição.
const CACHE_MS = 60000;
let cache = null;
let montando = null;

async function obterSnapshot(Pg) {
  if (cache && Date.now() - cache.em < CACHE_MS) return cache.snap;
  if (!montando) {
    montando = montarDoBanco(Pg)
      .then(snap => { cache = { snap, em: Date.now() }; return snap; })
      .finally(() => { montando = null; });
  }
  return montando;
}

// Config salva ou leitura nova -> próximo GET remonta
function invalidarCache() { cache = null; }

// Pipes da org para a tela de config: do espelho; se ainda vazio, do Pipefy
async function listarPipesEspelho(Pg) {
  const rows = await Pg.connectAndQuery(
    `SELECT pipe_id, nome, abertos_estimados FROM tab_painel_pipefy_pipe`, {});
  if (!rows.length) return listarPipesOrg();
  return rows.map(r => ({ id: trim(r.pipe_id), nome: trim(r.nome), abertosEstimados: Number(r.abertos_estimados || 0) }));
}

// Resposta da TV: sem os campos pesados da Visão Executiva
function paraTv(snap) {
  const { cards, setorPorResp, camposExt: _c, pipesComErro, ...resto } = snap;
  return resto;
}

module.exports = {
  disponivel, obterSnapshot, listarPipesOrg, listarPipesEspelho, invalidarCache, lerHistorico, paraTv,
  sincronizar, lerPipeAgora, definirAgenda, lerGestoresAgora
};

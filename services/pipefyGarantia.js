// services/pipefyGarantia.js — robô "entrega confirmada no Datafrete -> card
// concluído no Pipefy". Nasceu para a fase "ACOMPANHAMENTO DA ENTREGA" do pipe de
// Garantia (18/08/2026) e em 17/11/2026 virou uma LISTA de pipes (ROBOS, abaixo):
// o ciclo é o mesmo, muda só onde ler a NF e o que fazer no card.
//
// Ciclo (por pipe ativo): lista os cards da fase de origem -> lê a NF do card ->
// resolve série/chave na SF2 (Protheus) -> procura a NF nas ocorrências do
// Datafrete (UMA consulta por execução, serve todos os pipes) -> ENTREGUE? marca
// o card (status ou etiquetas, conforme o pipe) e move pra fase de destino.
// Tudo logado em tab_garantia_entrega_log (migrations 94 + 154) + Auditoria no
// movimento real.
//
// Gates (.env) — cada pipe tem o seu par, um não liga o outro:
//   GARANTIA_ENTREGA_ATIVO=1 / GARANTIA_ENTREGA_SIMULAR=0            pipe 306873829
//   ENTREGA_PIPE_304879138_ATIVO=1 / ENTREGA_PIPE_304879138_SIMULAR=0  pipe 304879138
//     ATIVO=1    liga o robô daquele pipe (default DESLIGADO)
//     SIMULAR=0  desliga o dry-run (default SIMULA: loga o que faria, não mexe no Pipefy)
//   PIPEFY_TOKEN                mesmo do pipefyOp
//   DATAFRETE_SERVICES_KEY      client em services/datafreteTms.js
//   DATAFRETE_OCO_JANELA_DIAS   janela de ocorrências (default 7)
//
// Regra de "entregue" e contrato do Datafrete: ver datafreteTms.js.

const Metrica = require('./pipefyMetrica');
const Datafrete = require('./datafreteTms');

const trim = (v) => String(v == null ? '' : v).trim();
// Compara rótulos sem depender de acento, caixa ou pontuação ("NÚMERO DA NF:" = "numero da nf")
const norm = (v) => trim(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

// Cada pipe acompanhado. campoNf: `id` (slug do campo) OU `rotulo` (texto do campo
// na tela — usado quando o slug não é conhecido). `campoStatus` e `etiquetas` são
// opcionais e dizem o que marcar no card além de mover.
const ROBOS = [
  {
    chave: 'garantia',
    nome: 'Garantia de Peças',
    pipeId: '306873829',                 // SOLICITAÇÃO DE PEÇAS EM GARANTIA - VER.01
    faseOrigem: '341438230',             // ACOMPANHAMENTO DA ENTREGA
    faseDestino: '341436415',            // CONCLUÍDO
    campoNf: { id: 'n_mero_da_nota_fiscal' },
    campoStatus: 'status_do_transporte', // best-effort (ver marcarEntregue)
    envAtivo: 'GARANTIA_ENTREGA_ATIVO',
    envSimular: 'GARANTIA_ENTREGA_SIMULAR',
    metrica: 'garantia',
    auditoria: { modulo: 'Garantia', submodulo: 'Entrega' }
  },
  {
    chave: 'pipe304879138',
    nome: 'Pipe 304879138',
    pipeId: '304879138',
    faseOrigem: '329668891',             // onde o card espera a entrega
    faseDestino: '329478338',            // CONCLUÍDO
    campoNf: { rotulo: 'NÚMERO DA NF' }, // preenchido na fase FATURAMENTO (329668254)
    etiquetas: { remover: 'EM TRANSPORTE', adicionar: 'ENTREGUE' },
    envAtivo: 'ENTREGA_PIPE_304879138_ATIVO',
    envSimular: 'ENTREGA_PIPE_304879138_SIMULAR',
    metrica: 'entrega-304879138',
    auditoria: { modulo: 'Pipefy', submodulo: 'Entrega 304879138' }
  }
];

const TOKEN = () => trim(process.env.PIPEFY_TOKEN);
const ativo = (robo) => trim(process.env[robo.envAtivo]) === '1';
const simular = (robo) => trim(process.env[robo.envSimular]) !== '0';   // default: simula
// Janela de ocorrências (dias). Default 7 (27/08, a pedido do usuário) p/ dar folga
// caso um card fique alguns dias na fase após a entrega; env sobrepõe (máx 30, o
// client fatia em blocos de 5). Antes era 3.
const JANELA_DIAS = () => Math.max(1, Number(process.env.DATAFRETE_OCO_JANELA_DIAS || 7));

const robosAtivos = () => (TOKEN() && Datafrete.disponivel()) ? ROBOS.filter(ativo) : [];
const disponivel = () => robosAtivos().length > 0;

async function gql(robo, query, variables) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    Metrica.contar(robo.metrica);   // consumo do contrato do Pipefy (tab_pipefy_uso)
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

// Cards da fase de origem (paginado)
async function listarCards(robo) {
  const cards = [];
  let after = null;
  do {
    const d = await gql(robo, `query($fase: ID!, $a: String) {
      phase(id: $fase) {
        cards(first: 50, after: $a) {
          pageInfo { hasNextPage endCursor }
          edges { node { id title labels { id name } fields { name value field { id internal_id } } } }
        }
      }
    }`, { fase: robo.faseOrigem, a: after });
    const pg = d.phase?.cards;
    (pg?.edges || []).forEach(e => cards.push(e.node));
    after = pg?.pageInfo?.hasNextPage ? pg.pageInfo.endCursor : null;
  } while (after);
  return cards;
}

// Casa pelo `id` (slug do campo, ex. 'n_mero_da_nota_fiscal') — NÃO pelo internal_id
// (numérico). ⚠️ Bug 24→27/08: comparava internal_id com o slug → NF vazia em TODO
// card → SEM_NF em toda execução (o robô nunca moveu nada desde o go-live).
// Sem slug conhecido, casa pelo rótulo do campo (f.name), normalizado.
function campoDoCard(card, ref) {
  const campos = card.fields || [];
  const f = ref.id
    ? campos.find(c => c.field?.id === ref.id)
    : campos.find(c => norm(c.name) === norm(ref.rotulo));
  return trim(f?.value);
}

// Série e chave NFe da NF na SF2 (a chave é o identificador exato no Datafrete).
// F2_DOC pode ter padding de zeros — compara também com a NF preenchida.
async function resolverNF(Protheus, nf) {
  const rows = await Protheus.connectAndQuery(`
    SELECT TOP 1 RTRIM(F2_DOC) doc, RTRIM(F2_SERIE) serie, RTRIM(ISNULL(F2_CHVNFE, '')) chave
      FROM SF2010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*'
       AND (RTRIM(F2_DOC) = @nf OR RTRIM(F2_DOC) = RIGHT(REPLICATE('0', 9) + @nf, 9))
     ORDER BY F2_EMISSAO DESC`, { nf });
  return rows.length ? { serie: trim(rows[0].serie), chave: trim(rows[0].chave) } : null;
}

// Etiquetas do pipe (id + nome). Lidas no máximo 1x por execução, e só quando há
// card entregue para tratar — não gasta chamada em ciclo sem entrega.
async function etiquetasDoPipe(robo, cache) {
  if (!cache.etiquetas) {
    const d = await gql(robo, `query($pipe: ID!) { pipe(id: $pipe) { labels { id name } } }`, { pipe: robo.pipeId });
    cache.etiquetas = d.pipe?.labels || [];
  }
  return cache.etiquetas;
}

// Conjunto final de etiquetas do card: tira a "remover", põe a "adicionar" e
// preserva as demais. Lança se a etiqueta a adicionar não existir no pipe —
// melhor parar com erro visível do que concluir o card sem a marca pedida.
async function novasEtiquetas(robo, card, cache) {
  const doPipe = await etiquetasDoPipe(robo, cache);
  const alvo = doPipe.find(l => norm(l.name) === norm(robo.etiquetas.adicionar));
  if (!alvo) throw new Error(`etiqueta "${robo.etiquetas.adicionar}" não existe no pipe ${robo.pipeId}`);
  const ids = (card.labels || [])
    .filter(l => norm(l.name) !== norm(robo.etiquetas.remover))
    .map(l => String(l.id));
  if (!ids.includes(String(alvo.id))) ids.push(String(alvo.id));
  return ids;
}

// Marca o card como entregue e move pra fase de destino.
// - campoStatus (Garantia): BEST-EFFORT. ⚠️ O `status_do_transporte` é um
//   label_select SEM options configuradas na API → o updateFieldsValues rejeita
//   ("Dado fornecido inválido") e NÃO pode bloquear o MOVE, que é a ação que
//   realmente importa (concluir o card destrava a fase dependente do G-Care).
// - etiquetas: OBRIGATÓRIO e ANTES do move. Se falhar, o card fica na fase e o
//   próximo ciclo tenta de novo — depois de movido o robô não o enxerga mais, e
//   ele ficaria em CONCLUÍDO com a etiqueta errada para sempre.
async function marcarEntregue(robo, card, cache) {
  if (robo.campoStatus) {
    try {
      await gql(robo, `mutation($card: ID!, $campo: ID!, $valor: [UndefinedInput]) {
        updateFieldsValues(input: { nodeId: $card, values: [{ fieldId: $campo, value: $valor }] }) { success }
      }`, { card: card.id, campo: robo.campoStatus, valor: ['ENTREGUE'] });
    } catch (e) { console.warn(`[entrega:${robo.chave}] set status falhou (segue p/ o move):`, e.message); }
  }
  if (robo.etiquetas) {
    const ids = await novasEtiquetas(robo, card, cache);
    await gql(robo, `mutation($card: ID!, $ids: [ID]) {
      updateCard(input: { id: $card, label_ids: $ids }) { card { id } }
    }`, { card: card.id, ids });
  }
  await gql(robo, `mutation($card: ID!, $fase: ID!) {
    moveCardToPhase(input: { card_id: $card, destination_phase_id: $fase }) { card { id } }
  }`, { card: card.id, fase: robo.faseDestino });
}

const descreverAcao = (robo) => [
  robo.campoStatus ? 'status=ENTREGUE' : null,
  robo.etiquetas ? `etiqueta ${robo.etiquetas.remover} -> ${robo.etiquetas.adicionar}` : null,
  'movido p/ CONCLUÍDO'
].filter(Boolean).join(' + ');

// Uma execução completa (todos os pipes ativos). origem = 'CRON' | 'MANUAL' | 'WEBHOOK'.
// Devolve o resumo somado + `pipes` com o resumo de cada um.
async function executar(app, origem = 'CRON') {
  const { Pg, Protheus } = app.services ? app.services : app;   // aceita app ou services
  const novo = () => ({ cards: 0, entregues: 0, movidos: 0, simulados: 0, erros: 0, detalhes: [] });
  const total = { ...novo(), pipes: {} };
  const logar = async (robo, card, r) => {
    try {
      await Pg.connectAndQuery(`
        INSERT INTO tab_garantia_entrega_log (pipe_id, card_id, card_title, nf, serie_nf, chave_nf, resultado, detalhe, origem)
        VALUES (@pipe, @id, @titulo, @nf, @serie, @chave, @res, @det, @origem)`,
        { pipe: robo.pipeId, id: trim(card.id), titulo: trim(card.title).slice(0, 200), nf: r.nf || null,
          serie: r.serie || null, chave: r.chave || null, res: r.resultado, det: (r.detalhe || '').slice(0, 1500), origem });
    } catch (e) { console.error(`[entrega:${robo.chave}] log falhou:`, e.message); }
  };

  const robos = robosAtivos();
  if (!robos.length) return { ...total, inativo: true };

  // Lista os cards de cada pipe; só consulta o Datafrete se houver card esperando.
  const filas = [];
  for (const robo of robos) {
    const resumo = total.pipes[robo.chave] = novo();
    try {
      const cards = await listarCards(robo);
      resumo.cards = cards.length;
      if (cards.length) filas.push({ robo, resumo, cards });
    } catch (e) {
      resumo.erros++;
      resumo.detalhes.push(e.message);
      await logar(robo, { id: 'RUN', title: 'listar cards da fase' }, { resultado: 'ERRO', detalhe: e.message });
    }
  }

  let entregas = [];
  if (filas.length) {
    // 1 chamada de ocorrências pra execução inteira (janela em dias)
    const oco = await Datafrete.consultarOcorrencias({ dias: JANELA_DIAS() });
    if (!oco.ok) {
      // loga UMA linha de erro por pipe (não uma por card) e encerra
      for (const { robo, resumo, cards } of filas) {
        resumo.erros++;
        resumo.detalhes.push(`Datafrete HTTP ${oco.http}: ${(oco.txt || '').slice(0, 200)}`);
        await logar(robo, { id: 'RUN', title: `${cards.length} card(s) na fase` }, {
          resultado: 'ERRO_DATAFRETE', detalhe: `HTTP ${oco.http} — ${(oco.txt || '').slice(0, 800)}`
        });
      }
      filas.length = 0;
    } else {
      entregas = Datafrete.extrairEntregas(oco.eventos);
    }
  }

  for (const { robo, resumo, cards } of filas) {
    const cache = {};   // etiquetas do pipe, lidas sob demanda
    for (const card of cards) {
      const nf = campoDoCard(card, robo.campoNf).replace(/\D/g, '');
      if (!nf) { await logar(robo, card, { resultado: 'SEM_NF', detalhe: 'card sem número de NF' }); continue; }

      let ref = null;
      try { ref = await resolverNF(Protheus, nf); } catch (e) {
        resumo.erros++; await logar(robo, card, { nf, resultado: 'ERRO', detalhe: 'SF2: ' + e.message }); continue;
      }
      if (!ref) { await logar(robo, card, { nf, resultado: 'NF_NAO_ENCONTRADA', detalhe: 'NF não achada na SF2' }); continue; }

      const match = entregas.find(e =>
        (ref.chave && e.chaveNf === ref.chave) ||
        (e.numeroNf && e.numeroNf.replace(/^0+/, '') === nf.replace(/^0+/, '')));

      if (!match) { await logar(robo, card, { nf, ...ref, resultado: 'SEM_OCORRENCIA', detalhe: `janela ${JANELA_DIAS()}d sem ocorrência da NF` }); continue; }
      if (!match.entregue) { await logar(robo, card, { nf, ...ref, resultado: 'EM_TRANSITO', detalhe: match.descricao }); continue; }

      resumo.entregues++;
      if (simular(robo)) {
        resumo.simulados++;
        // Na simulação já confere (só leitura) se as etiquetas existem — assim o
        // problema aparece ANTES de ligar o modo real.
        let aviso = '';
        if (robo.etiquetas) {
          try { await novasEtiquetas(robo, card, cache); } catch (e) { aviso = ` ⚠️ ${e.message}`; }
        }
        await logar(robo, card, { nf, ...ref, resultado: 'ENTREGUE_SIMULADO',
          detalhe: `SIMULAÇÃO — faria: ${descreverAcao(robo)}.${aviso} Ocorrência: ${match.descricao}` });
        continue;
      }
      try {
        await marcarEntregue(robo, card, cache);
        resumo.movidos++;
        await logar(robo, card, { nf, ...ref, resultado: 'ENTREGUE_MOVIDO', detalhe: `${descreverAcao(robo)}. Ocorrência: ${match.descricao}` });
        try {
          const Auditoria = require('./auditoria');
          Auditoria.registrar({ services: { Pg } }, {
            ...robo.auditoria, acao: 'CARD_CONCLUIDO', severidade: 'ALERTA',
            entidade: 'pipefy_card', entidadeId: trim(card.id),
            descricao: `NF ${nf} entregue — card "${trim(card.title).slice(0, 80)}" movido p/ CONCLUÍDO (${origem})`
          });
        } catch (e) { console.warn(`[entrega:${robo.chave}] auditoria:`, e.message); }
      } catch (e) {
        resumo.erros++;
        await logar(robo, card, { nf, ...ref, resultado: 'ERRO', detalhe: 'Pipefy: ' + e.message });
      }
    }
  }

  for (const r of Object.values(total.pipes)) {
    for (const k of ['cards', 'entregues', 'movidos', 'simulados', 'erros']) total[k] += r[k];
    total.detalhes.push(...r.detalhes);
  }
  return total;
}

const GARANTIA = ROBOS[0];
module.exports = {
  disponivel, executar, ROBOS, campoDoCard, norm,
  // compatibilidade com quem importava as constantes da Garantia
  PIPE_ID: GARANTIA.pipeId, FASE_ACOMPANHAMENTO: GARANTIA.faseOrigem, FASE_CONCLUIDO: GARANTIA.faseDestino
};

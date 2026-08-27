// services/pipefyGarantia.js — robô da fase "ACOMPANHAMENTO DA ENTREGA" do pipe
// de Garantia (espelha o desenho do pipefyOp).
//
// Ciclo: lista os cards da fase -> lê a NF do card -> resolve série/chave na
// SF2 (Protheus) -> consulta ocorrências no Datafrete -> ENTREGUE? seta
// status_do_transporte="ENTREGUE" e move o card pra CONCLUÍDO (decisão do
// usuário 18/08: entregue SEMPRE vai pra CONCLUÍDO). Tudo logado em
// tab_garantia_entrega_log (migration 94) + Auditoria no movimento real.
//
// Gates (.env):
//   GARANTIA_ENTREGA_ATIVO=1    liga o robô (default DESLIGADO)
//   GARANTIA_ENTREGA_SIMULAR=0  desliga o dry-run (default SIMULA: loga o que
//                               faria, não mexe no Pipefy)
//   PIPEFY_TOKEN                mesmo do pipefyOp
//   DATAFRETE_SERVICES_KEY      client em services/datafreteTms.js
//   DATAFRETE_OCO_JANELA_DIAS   janela de ocorrências (default 3)
//
// Contrato do Datafrete descoberto/validado em 21/08/2026 (ver datafreteTms.js):
// entregue = cod_evento 1 ou 2. Match por chave NFe (SF2) com fallback numero.

const Datafrete = require('./datafreteTms');

const trim = (v) => String(v == null ? '' : v).trim();

const PIPE_ID = '306873829';           // SOLICITAÇÃO DE PEÇAS EM GARANTIA - VER.01
const FASE_ACOMPANHAMENTO = '341438230';
const FASE_CONCLUIDO = '341436415';
const CAMPO_NF = 'n_mero_da_nota_fiscal';
const CAMPO_STATUS = 'status_do_transporte';

const TOKEN = () => trim(process.env.PIPEFY_TOKEN);
const ATIVO = () => trim(process.env.GARANTIA_ENTREGA_ATIVO) === '1';
const SIMULAR = () => trim(process.env.GARANTIA_ENTREGA_SIMULAR) !== '0';   // default: simula
const JANELA_DIAS = () => Math.max(1, Number(process.env.DATAFRETE_OCO_JANELA_DIAS || 3));

const disponivel = () => ATIVO() && !!TOKEN() && Datafrete.disponivel();

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

// Cards da fase de acompanhamento (paginado)
async function listarCards() {
  const cards = [];
  let after = null;
  do {
    const d = await gql(`query($fase: ID!, $a: String) {
      phase(id: $fase) {
        cards(first: 50, after: $a) {
          pageInfo { hasNextPage endCursor }
          edges { node { id title fields { name value field { id internal_id } } } }
        }
      }
    }`, { fase: FASE_ACOMPANHAMENTO, a: after });
    const pg = d.phase?.cards;
    (pg?.edges || []).forEach(e => cards.push(e.node));
    after = pg?.pageInfo?.hasNextPage ? pg.pageInfo.endCursor : null;
  } while (after);
  return cards;
}

// Casa pelo `id` (slug do campo, ex. 'n_mero_da_nota_fiscal') — NÃO pelo internal_id
// (numérico). ⚠️ Bug 24→27/08: comparava internal_id com o slug → NF vazia em TODO
// card → SEM_NF em toda execução (o robô nunca moveu nada desde o go-live).
const campoDoCard = (card, fieldId) =>
  trim((card.fields || []).find(f => f.field?.id === fieldId)?.value);

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

// Seta o status (BEST-EFFORT) e move o card. ⚠️ O `status_do_transporte` é um
// label_select SEM options configuradas na API → o updateFieldsValues rejeita
// ("Dado fornecido inválido") e NÃO pode bloquear o MOVE, que é a ação que
// realmente importa (concluir o card destrava a fase dependente do G-Care).
async function marcarEntregue(cardId) {
  try {
    await gql(`mutation($card: ID!, $campo: ID!, $valor: [UndefinedInput]) {
      updateFieldsValues(input: { nodeId: $card, values: [{ fieldId: $campo, value: $valor }] }) { success }
    }`, { card: cardId, campo: CAMPO_STATUS, valor: ['ENTREGUE'] });
  } catch (e) { console.warn('[garantia-entrega] set status falhou (segue p/ o move):', e.message); }
  await gql(`mutation($card: ID!, $fase: ID!) {
    moveCardToPhase(input: { card_id: $card, destination_phase_id: $fase }) { card { id } }
  }`, { card: cardId, fase: FASE_CONCLUIDO });
}

// Uma execução completa. origem = 'CRON' | 'MANUAL'.
async function executar(app, origem = 'CRON') {
  const { Pg, Protheus } = app.services ? app.services : app;   // aceita app ou services
  const resumo = { cards: 0, entregues: 0, movidos: 0, simulados: 0, erros: 0, detalhes: [] };
  const logar = async (card, r) => {
    try {
      await Pg.connectAndQuery(`
        INSERT INTO tab_garantia_entrega_log (card_id, card_title, nf, serie_nf, chave_nf, resultado, detalhe, origem)
        VALUES (@id, @titulo, @nf, @serie, @chave, @res, @det, @origem)`,
        { id: trim(card.id), titulo: trim(card.title).slice(0, 200), nf: r.nf || null, serie: r.serie || null,
          chave: r.chave || null, res: r.resultado, det: (r.detalhe || '').slice(0, 1500), origem });
    } catch (e) { console.error('[garantia-entrega] log falhou:', e.message); }
  };

  if (!disponivel()) return { ...resumo, inativo: true };

  const cards = await listarCards();
  resumo.cards = cards.length;
  if (!cards.length) return resumo;

  // 1 chamada de ocorrências pro lote inteiro (janela em dias)
  const oco = await Datafrete.consultarOcorrencias({ dias: JANELA_DIAS() });
  if (!oco.ok) {
    resumo.erros++;
    resumo.detalhes.push(`Datafrete HTTP ${oco.http}: ${(oco.txt || '').slice(0, 200)}`);
    // loga UMA linha de erro por execução (não uma por card)
    await logar({ id: 'RUN', title: `${cards.length} card(s) na fase` }, {
      resultado: 'ERRO_DATAFRETE', detalhe: `HTTP ${oco.http} — ${(oco.txt || '').slice(0, 800)}`
    });
    return resumo;
  }
  const entregas = Datafrete.extrairEntregas(oco.eventos);

  for (const card of cards) {
    const nf = campoDoCard(card, CAMPO_NF).replace(/\D/g, '');
    if (!nf) { await logar(card, { resultado: 'SEM_NF', detalhe: 'card sem número de NF' }); continue; }

    let ref = null;
    try { ref = await resolverNF(Protheus, nf); } catch (e) {
      resumo.erros++; await logar(card, { nf, resultado: 'ERRO', detalhe: 'SF2: ' + e.message }); continue;
    }
    if (!ref) { await logar(card, { nf, resultado: 'NF_NAO_ENCONTRADA', detalhe: 'NF não achada na SF2' }); continue; }

    const match = entregas.find(e =>
      (ref.chave && e.chaveNf === ref.chave) ||
      (e.numeroNf && e.numeroNf.replace(/^0+/, '') === nf.replace(/^0+/, '')));

    if (!match) { await logar(card, { nf, ...ref, resultado: 'SEM_OCORRENCIA', detalhe: `janela ${JANELA_DIAS()}d sem ocorrência da NF` }); continue; }
    if (!match.entregue) { await logar(card, { nf, ...ref, resultado: 'EM_TRANSITO', detalhe: match.descricao }); continue; }

    resumo.entregues++;
    if (SIMULAR()) {
      resumo.simulados++;
      await logar(card, { nf, ...ref, resultado: 'ENTREGUE_SIMULADO', detalhe: `SIMULAÇÃO — seria movido p/ CONCLUÍDO. Ocorrência: ${match.descricao}` });
      continue;
    }
    try {
      await marcarEntregue(card.id);
      resumo.movidos++;
      await logar(card, { nf, ...ref, resultado: 'ENTREGUE_MOVIDO', detalhe: `status=ENTREGUE + movido p/ CONCLUÍDO. Ocorrência: ${match.descricao}` });
      try {
        const Auditoria = require('./auditoria');
        Auditoria.registrar({ services: { Pg } }, {
          modulo: 'Garantia', submodulo: 'Entrega', acao: 'CARD_CONCLUIDO', severidade: 'ALERTA',
          entidade: 'pipefy_card', entidadeId: trim(card.id),
          descricao: `NF ${nf} entregue — card "${trim(card.title).slice(0, 80)}" movido p/ CONCLUÍDO (${origem})`
        });
      } catch (e) { console.warn('[garantia-entrega] auditoria:', e.message); }
    } catch (e) {
      resumo.erros++;
      await logar(card, { nf, ...ref, resultado: 'ERRO', detalhe: 'Pipefy: ' + e.message });
    }
  }
  return resumo;
}

module.exports = { disponivel, executar, PIPE_ID, FASE_ACOMPANHAMENTO, FASE_CONCLUIDO };

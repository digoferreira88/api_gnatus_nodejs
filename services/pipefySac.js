// services/pipefySac.js — cruzamento da Pesquisa NPS com o pipe de reclamações do
// SAC (Atendimento ao Consumidor). Objetivo da TRAVA: não disparar a pesquisa
// automática para um cliente que está com atendimento ATIVO (card fora do
// "Concluído") — senão a nota de satisfação sai enviesada. Carrega uma vez por
// rodada do scheduler os CPFs/CNPJs com ocorrência aberta e deixa consultar por
// documento (cruza com o A1_CGC da SA1).
//
// ⚠️ O pipe indicado originalmente (303793124 "...- CONGELADO") está arquivado e
// sem movimento desde jun/2026. A versão ATIVA é a VER.01 (304770705). Config por
// env sobrepõe (troca de pipe = só .env, sem deploy):
//   NPS_SAC_PIPE           = 304770705  (02 | ATENDIMENTO AO CONSUMIDOR - VER.01)
//   NPS_SAC_FASE_CONCLUIDO = 328814465  (ÚNICA fase excluída do cruzamento)
// Campos do documento no card: informe_seu_cpf / informe_o_n_mero_do_cnpj.

const PIPE = () => String(process.env.NPS_SAC_PIPE || '304770705').trim();
const FASE_CONCLUIDO = () => String(process.env.NPS_SAC_FASE_CONCLUIDO || '328814465').trim();
const CAMPO_CPF = 'informe_seu_cpf';
const CAMPO_CNPJ = 'informe_o_n_mero_do_cnpj';
const TOKEN = () => String(process.env.PIPEFY_TOKEN || '').trim();

const soDig = (s) => String(s || '').replace(/\D/g, '');
const trim = (s) => String(s == null ? '' : s).trim();
const docValido = (d) => d.length === 11 || d.length === 14;   // CPF ou CNPJ

async function gql(query, variables) {
  const r = await fetch('https://api.pipefy.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN() },
    body: JSON.stringify({ query, variables: variables || {} })
  });
  const j = await r.json();
  if (j.errors) throw new Error('pipefy: ' + JSON.stringify(j.errors).slice(0, 200));
  return j.data;
}

// Carrega o mapa docDigits -> [ocorrências] varrendo TODAS as fases ativas
// (!= Concluído). Lança se o Pipefy falhar (o chamador decide fail-open).
// Retorna { mapa:Map, totalCards, pipeNome, fasesAtivas:[nomes] }.
async function carregarOcorrenciasAbertas() {
  if (!TOKEN()) throw new Error('PIPEFY_TOKEN ausente');
  const dp = await gql(`query($id: ID!){ pipe(id:$id){ name phases{ id name done cards_count } } }`, { id: PIPE() });
  const phases = dp?.pipe?.phases || [];
  const ativas = phases.filter(f => f.id !== FASE_CONCLUIDO() && Number(f.cards_count) > 0);

  const mapa = new Map();
  let totalCards = 0;
  for (const ph of ativas) {
    let after = null;
    do {
      const d = await gql(`query($id: ID!, $after: String){ phase(id:$id){ cards(first: 30, after: $after){
          pageInfo{ hasNextPage endCursor }
          edges{ node{ id title url fields{ value field{ id } } } }
      } } }`, { id: ph.id, after });
      const conn = d?.phase?.cards;
      (conn?.edges || []).forEach(e => {
        const n = e.node;
        totalCards++;
        const val = (fid) => { const f = (n.fields || []).find(x => x.field?.id === fid); return f ? trim(f.value) : ''; };
        [val(CAMPO_CPF), val(CAMPO_CNPJ)].forEach(doc => {
          const dig = soDig(doc);
          if (!docValido(dig)) return;
          const arr = mapa.get(dig) || [];
          arr.push({ cardId: n.id, titulo: trim(n.title), fase: ph.name, url: n.url });
          mapa.set(dig, arr);
        });
      });
      after = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (after);
  }
  return { mapa, totalCards, pipeNome: dp?.pipe?.name || '', fasesAtivas: ativas.map(f => f.name) };
}

// Consulta 1 documento (A1_CGC) num mapa já carregado. [] = sem ocorrência aberta.
function ocorrenciasDe(mapa, cgc) {
  const dig = soDig(cgc);
  if (!docValido(dig) || !mapa) return [];
  return mapa.get(dig) || [];
}

// Consulta ao vivo de 1 documento (revalida na decisão do operador). Carrega o
// mapa e faz o lookup. [] se doc inválido ou sem ocorrência.
async function consultarDoc(cgc) {
  const dig = soDig(cgc);
  if (!docValido(dig)) return [];
  const { mapa } = await carregarOcorrenciasAbertas();
  return mapa.get(dig) || [];
}

module.exports = { carregarOcorrenciasAbertas, ocorrenciasDe, consultarDoc, PIPE, FASE_CONCLUIDO };

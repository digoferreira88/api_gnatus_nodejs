// services/creditoRegras.js — motor de regras configurável (tab_credito_regras).
// Avalia as regras (por prioridade) sobre o contexto da análise; a 1ª que casa
// define o status (APROVAR | REVISAR | REPROVAR). Sem regra casada -> REVISAR.
//
// condicoes (jsonb): { "all": [cond...] } ou { "any": [cond...] }
//   cond = { campo, op, valor }   op: lt|lte|gt|gte|eq|ne|is_true|is_false

const N = (v) => Number(v || 0);

function testarCond(cond, ctx) {
  const atual = ctx[cond.campo];
  switch (cond.op) {
    case 'lt':  return N(atual) <  N(cond.valor);
    case 'lte': return N(atual) <= N(cond.valor);
    case 'gt':  return N(atual) >  N(cond.valor);
    case 'gte': return N(atual) >= N(cond.valor);
    case 'eq':  return String(atual) === String(cond.valor);
    case 'ne':  return String(atual) !== String(cond.valor);
    case 'is_true':  return atual === true;
    case 'is_false': return atual !== true;
    default: return false;
  }
}

function casa(condicoes, ctx) {
  if (!condicoes || typeof condicoes !== 'object') return false;
  if (Array.isArray(condicoes.all)) return condicoes.all.every(c => testarCond(c, ctx));
  if (Array.isArray(condicoes.any)) return condicoes.any.some(c => testarCond(c, ctx));
  return false;
}

// ctx esperado: { score_final, score_interno, media_atraso_dias, inadimplencia_pct,
//                 maior_atraso_dias, protesto_ativo, classificacao, bloqueado }
async function avaliar(Pg, ctx) {
  let regras = [];
  try {
    regras = await Pg.connectAndQuery(
      `SELECT id, nome, prioridade, condicoes, acao, mensagem FROM tab_credito_regras WHERE ativo = true ORDER BY prioridade ASC, id ASC`, {});
  } catch (e) { /* sem tabela -> fallback abaixo */ }

  for (const r of regras) {
    if (casa(r.condicoes, ctx)) {
      return { status: r.acao, regraId: r.id, regra: r.nome, mensagem: r.mensagem || '' };
    }
  }
  // Fallback (nenhuma regra casou): faixa intermediária -> revisão
  return { status: 'REVISAR', regraId: null, regra: 'Padrão', mensagem: 'Nenhuma regra específica casou — análise manual.' };
}

module.exports = { avaliar };

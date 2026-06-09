// services/creditoAnalise.js — monta o payload 360 (interno + bureau + blend +
// regras + limite + parecer + evolução). Usado pelo GET (lê cache do bureau) e
// pelo POST consultar-bureau (passa o resultado fresco). NÃO faz auditoria — cada
// resource registra a sua.

const Score = require('./creditoScore');
const Regras = require('./creditoRegras');
const Parecer = require('./creditoParecer');
const Bureau = require('./creditoBureau');

const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

function sugerirLimite(scoreFinal, limiteAtual, semHistorico) {
  if (semHistorico) return { valor: limiteAtual, nota: 'Sem histórico interno — manter até consulta externa.' };
  const f = scoreFinal >= 750 ? 1.2 : scoreFinal >= 600 ? 1.0 : scoreFinal >= 400 ? 0.7 : 0.3;
  return { valor: round1(limiteAtual * f),
    nota: f > 1 ? 'Score saudável — há espaço para aumento.' : f === 1 ? 'Manter o limite atual.' : 'Score de risco — reduzir exposição.' };
}

// bureau = resultado normalizado do Quod (ou null). Quando null, score_final = interno.
async function montar({ Pg, Protheus }, cod, loja, opts = {}) {
  const base = await Score.calcular({ Pg, Protheus }, cod, loja);
  if (!base) return null;

  const cfgBureau = await Bureau.cfg(Pg);
  // bureau: usa o resultado fresco (POST) ou lê o último em cache (GET).
  let bureau = opts.bureau || null;
  if (!bureau && opts.lerCache !== false) {
    bureau = await Bureau.lerCache(Pg, base.cliente.cnpj, cfgBureau.fonteAtiva);
  }
  const { scoreFinal, pesoExterno, ajustes } = Bureau.blend(base.scoreInterno, bureau, cfgBureau);
  const classificacao = Score.classificar(scoreFinal, null);

  const ctx = {
    score_final: scoreFinal, score_interno: base.scoreInterno,
    media_atraso_dias: base.indicadores.mediaAtrasoPond,
    inadimplencia_pct: base.indicadores.inadimplenciaPct,
    maior_atraso_dias: base.indicadores.maiorAtraso.dias,
    protesto_ativo: !!(bureau && bureau.protestos && bureau.protestos.ativo),
    bloqueado: base.cliente.bloqueado, classificacao: classificacao.label
  };
  const regra = await Regras.avaliar(Pg, ctx);
  const status = base.cliente.bloqueado ? 'REPROVAR' : regra.status;

  const limiteSugerido = sugerirLimite(scoreFinal, base.cliente.limite, base.indicadores.semHistorico);

  const parecer = await Parecer.gerar({
    cliente: base.cliente, indicadores: base.indicadores,
    scoreInterno: base.scoreInterno, classificacao, status, bureau
  });

  // score evolutivo (1 ponto/dia/cliente)
  try {
    await Pg.connectAndQuery(
      `INSERT INTO tab_credito_score_hist (cliente_cod, cliente_loja, score_final, classificacao)
       SELECT @cod,@loja,@sc,@cl WHERE NOT EXISTS (SELECT 1 FROM tab_credito_score_hist
         WHERE cliente_cod=@cod AND cliente_loja=@loja AND capturado_em::date = NOW()::date)`,
      { cod, loja, sc: scoreFinal, cl: classificacao.label });
  } catch (e) { /* best-effort */ }
  const evolucao = await Pg.connectAndQuery(
    `SELECT score_final, classificacao, capturado_em FROM tab_credito_score_hist
      WHERE cliente_cod=@cod AND cliente_loja=@loja ORDER BY capturado_em DESC LIMIT 24`, { cod, loja }).catch(() => []);

  return {
    cliente: base.cliente,
    contexto: opts.contexto || null,
    score: { interno: base.scoreInterno, externo: bureau ? (bureau.score ?? null) : null, final: scoreFinal, pesoExterno, classificacao },
    componentes: base.componentes,
    indicadores: base.indicadores,
    decisao: { status, regra: regra.regra, mensagem: regra.mensagem, forcadoBloqueio: base.cliente.bloqueado, ajustes },
    limite: { atual: base.cliente.limite, sugerido: limiteSugerido.valor, nota: limiteSugerido.nota },
    bureau: bureau ? { ...bureau, fonteAtiva: cfgBureau.fonteAtiva } : null,
    bureauDisponivel: Bureau.fonteDisponivel(cfgBureau.fonteAtiva),
    parecer: parecer.texto, parecerFonte: parecer.fonte,
    evolucao: (evolucao || []).reverse(),
    geradoEm: new Date().toISOString(),
    _scoreFinal: scoreFinal, _classificacao: classificacao, _status: status, _nome: base.cliente.nome, _cnpj: base.cliente.cnpj
  };
}

module.exports = { montar };

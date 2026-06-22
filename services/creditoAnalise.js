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

  // últimas compras + forma de pagamento (pedidos SC5 do cliente)
  const FORMAS_PGTO = {
    '1': 'Cheque', '2': 'Dinheiro', '3': 'Cartão', '4': 'Boleto', '5': 'Não informado',
    '6': 'Financiamento', '7': 'Cartão BNDES', '8': 'Bonificação', '9': 'Consignado',
    'A': 'Futuro Garantido', 'B': 'Antecipação Parcelada', '': '—'
  };
  let ultimasCompras = [];
  try {
    const rows = await Protheus.connectAndQuery(`
      SELECT TOP 10 RTRIM(sc5.C5_NUM) pedido, sc5.C5_EMISSAO emissao, RTRIM(sc5.C5_FORMAPG) forma,
             RTRIM(sc5.C5_CONDPAG) cond, CAST(ISNULL(tp6.total,0) AS NUMERIC(14,2)) total
        FROM SC5010 sc5 WITH (NOLOCK)
        LEFT JOIN total_pedido_sc6 tp6 WITH (NOLOCK) ON tp6.c6_num = sc5.C5_NUM
       WHERE sc5.C5_FILIAL='01' AND sc5.D_E_L_E_T_<>'*'
         AND RTRIM(sc5.C5_CLIENTE)=@cod AND RTRIM(sc5.C5_LOJACLI)=@loja
       ORDER BY sc5.C5_EMISSAO DESC, sc5.C5_NUM DESC`, { cod, loja });
    ultimasCompras = rows.map(r => {
      const f = String(r.forma == null ? '' : r.forma).trim();
      return {
        pedido: String(r.pedido || '').trim(), emissao: String(r.emissao || '').trim(),
        formaCod: f, forma: FORMAS_PGTO[f] || `Forma ${f}`,
        condPag: String(r.cond || '').trim(), total: Number(r.total || 0)
      };
    });
  } catch (e) { /* best-effort */ }

  // anotações do time (por cliente)
  let anotacao = { texto: '', por: null, em: null };
  try {
    const a = await Pg.connectAndQuery(
      `SELECT anotacoes, atualizado_por_nome, atualizado_em FROM tab_credito_anotacao WHERE cliente_cod=@cod AND cliente_loja=@loja`, { cod, loja });
    if (a[0]) anotacao = { texto: String(a[0].anotacoes || ''), por: a[0].atualizado_por_nome || null, em: a[0].atualizado_em || null };
  } catch (e) { /* tabela pode não existir ainda */ }

  return {
    ultimasCompras,
    anotacao,
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

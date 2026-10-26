// services/creditoAnalise.js — monta o payload 360 (interno + bureau + blend +
// regras + limite + parecer + evolução). Usado pelo GET (lê cache do bureau) e
// pelo POST consultar-bureau (passa o resultado fresco). NÃO faz auditoria — cada
// resource registra a sua.

const Score = require('./creditoScore');
const Regras = require('./creditoRegras');
const Parecer = require('./creditoParecer');
const Bureau = require('./creditoBureau');

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const trim = (v) => String(v == null ? '' : v).trim();
const ymdParaData = (s) => { s = trim(s); return s.length === 8 ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : ''; };
const brl = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ===== Limite calculado pelo sistema =====
// Limite = 30% do faturamento do cliente nos últimos 12 meses.
// "Faturamento" segue a mesma régua do Relatório de Faturamento e do Ranking:
// SD2 nas 20 CFOPs de venda, bruto − devolvido, sem Nota Complementar de ICMS.
const PCT_LIMITE = 0.30;
const CFOPS_FATURAMENTO = [
  '5105', '5106', '5116', '5117', '5119', '5405', '5933',
  '6105', '6106', '6107', '6108', '6109', '6110', '6116', '6117',
  '6119', '6122', '6123', '6404', '6933'
];

async function faturamento12m(Protheus, cod, loja) {
  const desde = Score.desdeMeses(12);
  const cfops = CFOPS_FATURAMENTO.map(c => `'${c}'`).join(',');
  const r = await Protheus.connectAndQuery(`
    SELECT CAST(ISNULL(SUM(CASE WHEN sd2.D2_EMISSAO >= @desde THEN sd2.D2_VALBRUT - sd2.D2_VALDEV ELSE 0 END), 0) AS NUMERIC(15,2)) fat,
           COUNT(DISTINCT CASE WHEN sd2.D2_EMISSAO >= @desde THEN sd2.D2_SERIE + sd2.D2_DOC END) nfs,
           MAX(sd2.D2_EMISSAO) ultima
      FROM SD2010 sd2 WITH (NOLOCK)
      JOIN SF2010 sf2 WITH (NOLOCK)
        ON sf2.F2_FILIAL = sd2.D2_FILIAL AND sf2.F2_DOC = sd2.D2_DOC AND sf2.F2_SERIE = sd2.D2_SERIE
       AND sf2.F2_CLIENTE = sd2.D2_CLIENTE AND sf2.F2_LOJA = sd2.D2_LOJA AND sf2.D_E_L_E_T_ <> '*'
     WHERE sd2.D_E_L_E_T_ <> '*' AND sd2.D2_FILIAL = '01'
       AND sd2.D2_CLIENTE = @cod AND sd2.D2_LOJA = @loja
       AND sd2.D2_CF IN (${cfops})
       AND ISNULL(sf2.F2_TIPO, 'N') <> 'I'`, { cod, loja, desde });
  const x = r[0] || {};
  return { valor: round2(x.fat), nfs: Number(x.nfs || 0), desde, ultima: trim(x.ultima) };
}

// Confere o limite calculado contra o score (interno, ou combinado com o Quod).
// Faixas: >= 600 confirma · 400–599 atenção · < 400 não conceder.
const SCORE_CONFIRMA = 600, SCORE_ATENCAO = 400;
function verificarScore({ score, label, semHistorico, comBureau, bloqueado }) {
  const s = Math.round(score);
  if (bloqueado) return { nivel: 'bloqueio', texto: 'Cliente bloqueado no cadastro — não conceder.' };
  if (semHistorico && !comBureau) {
    return { nivel: 'neutro', texto: `Score ${s} é neutro (sem títulos nos últimos 36 meses) — não confirma o limite; complemente com consulta externa.` };
  }
  if (s >= SCORE_CONFIRMA) return { nivel: 'ok', texto: `Score ${s} (${label}) confirma o limite.` };
  if (s >= SCORE_ATENCAO) return { nivel: 'atencao', texto: `Score ${s} (${label}) — avaliar antes de conceder o limite.` };
  return { nivel: 'bloqueio', texto: `Score ${s} (${label}) — não conceder sem análise.` };
}

function notaLimite(fat) {
  if (fat.valor > 0) return `${Math.round(PCT_LIMITE * 100)}% de ${brl(fat.valor)} faturados desde ${ymdParaData(fat.desde)} (${fat.nfs} nota(s)).`;
  return fat.ultima
    ? `Sem faturamento nos últimos 12 meses — último em ${ymdParaData(fat.ultima)}.`
    : 'Cliente sem faturamento registrado.';
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

  const fat = await faturamento12m(Protheus, cod, loja);
  const limite = {
    atual: base.cliente.limite,
    calculado: round2(fat.valor * PCT_LIMITE),
    percentual: Math.round(PCT_LIMITE * 100),
    faturamento12m: fat.valor, nfs12m: fat.nfs, desde: fat.desde, ultimoFaturamento: fat.ultima,
    nota: notaLimite(fat),
    verificacao: verificarScore({
      score: scoreFinal, label: classificacao.label, semHistorico: base.indicadores.semHistorico,
      comBureau: !!(bureau && bureau.score != null), bloqueado: base.cliente.bloqueado
    })
  };

  const parecer = await Parecer.gerar({
    cliente: base.cliente, indicadores: base.indicadores,
    scoreInterno: base.scoreInterno, classificacao, status, bureau, limite
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
    limite,
    bureau: bureau ? { ...bureau, fonteAtiva: cfgBureau.fonteAtiva } : null,
    bureauDisponivel: Bureau.fonteDisponivel(cfgBureau.fonteAtiva),
    parecer: parecer.texto, parecerFonte: parecer.fonte,
    evolucao: (evolucao || []).reverse(),
    geradoEm: new Date().toISOString(),
    _scoreFinal: scoreFinal, _classificacao: classificacao, _status: status, _nome: base.cliente.nome, _cnpj: base.cliente.cnpj
  };
}

module.exports = { montar, faturamento12m, verificarScore };

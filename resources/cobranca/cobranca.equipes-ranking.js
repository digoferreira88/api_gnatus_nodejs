// GET /cobranca/equipes-ranking?mesIni=YYYYMM&mesFim=YYYYMM
//   (legacy: anoMin=YYYY&anoMax=YYYY ainda aceito; mesIni/mesFim tem precedencia)
//
// Cruza faturamento × inadimplencia POR EQUIPE no periodo. Mesmo conceito
// do /cobranca/faturamento-vs-inadimplencia, mas agregando por equipe (1
// linha por equipe) em vez de por mes.
//
// Equipe vem da tabela PG tab_cobranca_bu_equipe (label da BU -> equipe).
// BUs sem mapeamento aparecem agregadas em "Sem equipe".

const trim = (v) => String(v || '').trim();
const toN = (v) => Number(v || 0);

// CFOPs de venda (mesma lista de cobranca.faturamento-vs-inadimplencia)
const CFOPS_VENDA = [
  '5101','5102','5103','5104','5105','5106','5109','5110','5111','5112','5113','5114','5115','5116','5117','5118','5119','5120','5122','5123','5129',
  '5251','5252','5253','5254','5255','5256','5257','5258','5301','5302','5303','5304','5305','5306','5307','5351','5352','5353','5354','5355','5356','5357','5359','5360',
  '5401','5402','5403','5405','5651','5652','5653','5654','5655','5656','5667','5932','5933',
  '6101','6102','6103','6104','6105','6106','6107','6108','6109','6110','6111','6112','6113','6114','6115','6116','6117','6118','6119','6120','6122','6123','6129',
  '6251','6252','6253','6254','6255','6256','6257','6258','6301','6302','6303','6304','6305','6306','6307','6351','6352','6353','6354','6355','6356','6357','6359','6360',
  '6401','6402','6403','6404','6651','6652','6653','6654','6655','6656','6667','6932','6933',
  '7101','7102','7105','7106','7127','7129','7251','7301','7358','7651','7654','7667'
];

// Expressao SQL pra calcular o label da BU (X5_DESCRI ou "<cod> (Desconhecido)")
// — mesma logica do dashboard pra garantir que o cruzamento bata.
const EXPR_BU_LABEL = `COALESCE(NULLIF(RTRIM(bu_sx5.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO) + ' (Desconhecido)')`;

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001]);

module.exports = (app) => ({
  verb: 'get',
  route: '/equipes-ranking',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;

    // Aceita mesIni/mesFim (YYYYMM, novo) ou anoMin/anoMax (YYYY, legacy)
    const mesIniRaw = String(req.query.mesIni || '').trim();
    const mesFimRaw = String(req.query.mesFim || '').trim();
    const usaMes = /^\d{6}$/.test(mesIniRaw) && /^\d{6}$/.test(mesFimRaw);

    let inicioStr, fimStr, periodo;
    if (usaMes) {
      const aIni = mesIniRaw.slice(0, 4), mIni = mesIniRaw.slice(4, 6);
      const aFim = mesFimRaw.slice(0, 4), mFim = mesFimRaw.slice(4, 6);
      if (mesIniRaw > mesFimRaw) {
        return res.status(400).json({ message: 'mesIni nao pode ser maior que mesFim.' });
      }
      // Ultimo dia do mes de fim — calcula via Date pra cobrir 28/29/30/31 corretamente
      const ultimoDia = new Date(Number(aFim), Number(mFim), 0).getDate();
      inicioStr = `${aIni}${mIni}01`;
      fimStr    = `${aFim}${mFim}${String(ultimoDia).padStart(2, '0')}`;
      periodo = { mesIni: mesIniRaw, mesFim: mesFimRaw };
    } else {
      const anoAtual = new Date().getFullYear();
      const anoMin = Number(req.query.anoMin) || (anoAtual - 1);
      const anoMax = Number(req.query.anoMax) || anoAtual;
      if (anoMin < 2018 || anoMax > 2050 || anoMin > anoMax) {
        return res.status(400).json({ message: 'Parametros anoMin/anoMax invalidos.' });
      }
      inicioStr = `${anoMin}0101`;
      fimStr    = `${anoMax}1231`;
      periodo = { anoMin, anoMax };
    }
    const cfopList  = CFOPS_VENDA.map(c => `'${c}'`).join(',');

    try {
      // Mapeamento BU label -> equipe (do PG)
      const buEqRows = await Pg.connectAndQuery(
        `SELECT bu_codigo, equipe FROM tab_cobranca_bu_equipe`, {}
      );
      const mapBuEquipe = new Map();
      buEqRows.forEach(r => mapBuEquipe.set(trim(r.bu_codigo), trim(r.equipe)));

      // 1) Faturamento por BU (NF saida)
      const fatRows = await Protheus.connectAndQuery(`
        SELECT ${EXPR_BU_LABEL} buLabel, SUM(sd2.D2_VALBRUT) faturado
          FROM SF2010 sf2 WITH (NOLOCK)
          INNER JOIN SD2010 sd2 WITH (NOLOCK)
            ON sd2.D2_FILIAL = sf2.F2_FILIAL
           AND sd2.D2_DOC    = sf2.F2_DOC
           AND sd2.D2_SERIE  = sf2.F2_SERIE
           AND sd2.D2_CLIENTE= sf2.F2_CLIENTE
           AND sd2.D2_LOJA   = sf2.F2_LOJA
           AND sd2.D_E_L_E_T_ <> '*'
           AND sd2.D2_CF IN (${cfopList})
          LEFT JOIN SC5010 sc5 WITH (NOLOCK)
            ON sc5.C5_FILIAL = sd2.D2_FILIAL AND sc5.C5_NUM = sd2.D2_PEDIDO
           AND sc5.D_E_L_E_T_ <> '*'
          LEFT JOIN SX5010 bu_sx5 WITH (NOLOCK)
            ON bu_sx5.X5_FILIAL = '  ' AND bu_sx5.X5_TABELA = 'Z1'
           AND RTRIM(bu_sx5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO)
           AND bu_sx5.D_E_L_E_T_ <> '*'
         WHERE sf2.D_E_L_E_T_ <> '*'
           AND sf2.F2_FILIAL = '01'
           AND sf2.F2_EMISSAO BETWEEN @ini AND @fim
         GROUP BY ${EXPR_BU_LABEL}`,
        { ini: inicioStr, fim: fimStr }
      );

      // 2) Inadimplencia por BU (titulos nao pagos e vencidos)
      const inadRows = await Protheus.connectAndQuery(`
        SELECT ${EXPR_BU_LABEL} buLabel, SUM(se1.E1_SALDO) saldoVencido, COUNT(*) qtdTitulos
          FROM SE1010 se1 WITH (NOLOCK)
          LEFT JOIN SC5010 sc5 WITH (NOLOCK)
            ON sc5.C5_FILIAL = se1.E1_FILIAL AND sc5.C5_NUM = se1.E1_PEDIDO
           AND sc5.D_E_L_E_T_ <> '*'
          LEFT JOIN SX5010 bu_sx5 WITH (NOLOCK)
            ON bu_sx5.X5_FILIAL = '  ' AND bu_sx5.X5_TABELA = 'Z1'
           AND RTRIM(bu_sx5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO)
           AND bu_sx5.D_E_L_E_T_ <> '*'
         WHERE se1.D_E_L_E_T_ <> '*'
           AND se1.E1_FILIAL = '01'
           AND se1.E1_SALDO > 0
           AND CONVERT(date, se1.E1_VENCREA, 112) <= CONVERT(date, GETDATE())
           AND se1.E1_EMISSAO BETWEEN @ini AND @fim
           AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
         GROUP BY ${EXPR_BU_LABEL}`,
        { ini: inicioStr, fim: fimStr }
      );

      // Agregacao: traduz BU -> equipe e soma
      const porEquipe = new Map();
      const ensure = (eq) => {
        if (!porEquipe.has(eq)) porEquipe.set(eq, { equipe: eq, faturamento: 0, inadimplencia: 0, qtdTitulosVencidos: 0, bus: [] });
        return porEquipe.get(eq);
      };

      fatRows.forEach(r => {
        const buLabel = trim(r.buLabel);
        const equipe = mapBuEquipe.get(buLabel) || 'Sem equipe';
        ensure(equipe).faturamento += toN(r.faturado);
      });
      inadRows.forEach(r => {
        const buLabel = trim(r.buLabel);
        const equipe = mapBuEquipe.get(buLabel) || 'Sem equipe';
        const e = ensure(equipe);
        e.inadimplencia += toN(r.saldoVencido);
        e.qtdTitulosVencidos += toN(r.qtdTitulos);
      });

      const totalFat  = [...porEquipe.values()].reduce((s, e) => s + e.faturamento, 0);
      const totalInad = [...porEquipe.values()].reduce((s, e) => s + e.inadimplencia, 0);

      const ranking = [...porEquipe.values()].map(e => ({
        equipe: e.equipe,
        faturamento: Number(e.faturamento.toFixed(2)),
        inadimplencia: Number(e.inadimplencia.toFixed(2)),
        pctInadimplencia: e.faturamento > 0 ? Number(((e.inadimplencia / e.faturamento) * 100).toFixed(2)) : 0,
        pctFaturamentoTotal: totalFat > 0 ? Number(((e.faturamento / totalFat) * 100).toFixed(2)) : 0,
        pctInadimplenciaTotal: totalInad > 0 ? Number(((e.inadimplencia / totalInad) * 100).toFixed(2)) : 0,
        qtdTitulosVencidos: e.qtdTitulosVencidos
      })).sort((a, b) => b.faturamento - a.faturamento);

      return res.json({
        periodo,
        totais: {
          faturamento: Number(totalFat.toFixed(2)),
          inadimplencia: Number(totalInad.toFixed(2)),
          pctInadimplencia: totalFat > 0 ? Number(((totalInad / totalFat) * 100).toFixed(2)) : 0,
          qtEquipes: ranking.length
        },
        ranking,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('cobranca/equipes-ranking:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

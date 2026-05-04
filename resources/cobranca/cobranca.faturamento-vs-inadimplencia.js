// Faturamento (NF saida) vs Inadimplencia (titulos nao pagos do MESMO periodo
// emissao). Compara mes a mes — gestor ve quanto do que foi faturado virou
// inadimplencia no mesmo mes.
//
// GET /cobranca/faturamento-vs-inadimplencia?anoMin=YYYY&anoMax=YYYY
//
// Faturamento: SF2 (notas saida) somando F2_VALBRUT por mes de emissao,
//   filtrado por CFOPs de venda (mesma lista do relatorio de faturamento).
// Inadimplencia: SE1 (titulos a receber) onde SALDO > 0 (nao pago) e
//   E1_VENCREA <= hoje (vencido), agrupado por mes de E1_EMISSAO.

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

// CFOPs de venda — alinhado com vendas/faturamento-relatorio
const CFOPS_VENDA = [
  '5101','5102','5103','5104','5105','5106','5109','5110','5111','5112','5113','5114','5115','5116','5117','5118','5119','5120','5122','5123','5129',
  '5251','5252','5253','5254','5255','5256','5257','5258','5301','5302','5303','5304','5305','5306','5307','5351','5352','5353','5354','5355','5356','5357','5359','5360',
  '5401','5402','5403','5405','5651','5652','5653','5654','5655','5656','5667','5932','5933',
  '6101','6102','6103','6104','6105','6106','6107','6108','6109','6110','6111','6112','6113','6114','6115','6116','6117','6118','6119','6120','6122','6123','6129',
  '6251','6252','6253','6254','6255','6256','6257','6258','6301','6302','6303','6304','6305','6306','6307','6351','6352','6353','6354','6355','6356','6357','6359','6360',
  '6401','6402','6403','6404','6651','6652','6653','6654','6655','6656','6667','6932','6933',
  '7101','7102','7105','7106','7127','7129','7251','7301','7358','7651','7654','7667'
];

module.exports = (app) => ({
  verb: 'get',
  route: '/faturamento-vs-inadimplencia',

  handler: async (req, res) => {
    const { Protheus } = app.services;

    const anoAtual = new Date().getFullYear();
    const anoMin = Number(req.query.anoMin) || (anoAtual - 1);
    const anoMax = Number(req.query.anoMax) || anoAtual;
    if (anoMin < 2018 || anoMax > 2050 || anoMin > anoMax) {
      return res.status(400).json({ message: 'Parametros anoMin/anoMax invalidos.' });
    }

    const inicioStr = `${anoMin}0101`;
    const fimStr    = `${anoMax}1231`;
    const cfopList  = CFOPS_VENDA.map(c => `'${c}'`).join(',');

    try {
      // 1) Faturamento por mes (NF saida)
      const fatRows = await Protheus.connectAndQuery(`
        SELECT SUBSTRING(sf2.F2_EMISSAO, 1, 6) ymes,
               SUM(sd2.D2_VALBRUT) faturado
          FROM SF2010 sf2 WITH (NOLOCK)
          INNER JOIN SD2010 sd2 WITH (NOLOCK)
            ON sd2.D2_FILIAL = sf2.F2_FILIAL
           AND sd2.D2_DOC    = sf2.F2_DOC
           AND sd2.D2_SERIE  = sf2.F2_SERIE
           AND sd2.D2_CLIENTE = sf2.F2_CLIENTE
           AND sd2.D2_LOJA    = sf2.F2_LOJA
           AND sd2.D_E_L_E_T_ <> '*'
           AND sd2.D2_CF IN (${cfopList})
         WHERE sf2.D_E_L_E_T_ <> '*'
           AND sf2.F2_FILIAL = '01'
           AND sf2.F2_EMISSAO BETWEEN @ini AND @fim
         GROUP BY SUBSTRING(sf2.F2_EMISSAO, 1, 6)
         ORDER BY ymes`,
        { ini: inicioStr, fim: fimStr }
      );

      // 2) Inadimplencia por mes de EMISSAO do titulo (titulos nao pagos e VENCIDOS)
      // SE1 com saldo > 0 e vencimento real <= hoje
      const inadRows = await Protheus.connectAndQuery(`
        SELECT SUBSTRING(se1.E1_EMISSAO, 1, 6) ymes,
               SUM(se1.E1_SALDO) saldoVencido,
               COUNT(*) qtdTitulos
          FROM SE1010 se1 WITH (NOLOCK)
         WHERE se1.D_E_L_E_T_ <> '*'
           AND se1.E1_FILIAL = '01'
           AND se1.E1_SALDO > 0
           AND CONVERT(date, se1.E1_VENCREA, 112) <= CONVERT(date, GETDATE())
           AND se1.E1_EMISSAO BETWEEN @ini AND @fim
           AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
         GROUP BY SUBSTRING(se1.E1_EMISSAO, 1, 6)
         ORDER BY ymes`,
        { ini: inicioStr, fim: fimStr }
      );

      // Junta as duas series por ymes
      const map = new Map();
      const ymeses = new Set();
      fatRows.forEach(r => {
        const k = trim(r.ymes);
        ymeses.add(k);
        if (!map.has(k)) map.set(k, { ymes: k, faturado: 0, inadimplencia: 0, qtdTitulos: 0 });
        map.get(k).faturado = toN(r.faturado);
      });
      inadRows.forEach(r => {
        const k = trim(r.ymes);
        ymeses.add(k);
        if (!map.has(k)) map.set(k, { ymes: k, faturado: 0, inadimplencia: 0, qtdTitulos: 0 });
        map.get(k).inadimplencia = toN(r.saldoVencido);
        map.get(k).qtdTitulos = toN(r.qtdTitulos);
      });

      const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
      const serie = [...ymeses].sort().map(k => {
        const m = map.get(k);
        const ano = k.slice(0, 4);
        const mes = Number(k.slice(4, 6));
        const pct = m.faturado > 0 ? (m.inadimplencia / m.faturado) * 100 : 0;
        return {
          ymes: k,
          ano, mes,
          label: `${meses[mes - 1]}/${ano.slice(2)}`,
          faturado: Number(m.faturado.toFixed(2)),
          inadimplencia: Number(m.inadimplencia.toFixed(2)),
          qtdTitulos: m.qtdTitulos,
          pctInadimplencia: Number(pct.toFixed(2))
        };
      });

      // Totais consolidados do periodo
      const totFat = serie.reduce((s, x) => s + x.faturado, 0);
      const totInad = serie.reduce((s, x) => s + x.inadimplencia, 0);

      return res.json({
        periodo: { anoMin, anoMax },
        totais: {
          faturado: Number(totFat.toFixed(2)),
          inadimplencia: Number(totInad.toFixed(2)),
          pctInadimplencia: totFat > 0 ? Number(((totInad / totFat) * 100).toFixed(2)) : 0
        },
        serie,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro cobranca/faturamento-vs-inadimplencia:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

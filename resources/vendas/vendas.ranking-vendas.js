// GET /vendas/ranking-vendas?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&vendedor=&bu=
//
// Ranking de vendedores por VENDAS COLOCADAS no periodo. "Venda" aqui = todo
// pedido emitido no intervalo, *independente* de ter sido ou nao faturado.
// Por isso o numero NAO bate com o ranking de faturamento (SD2/NF):
//   - pedido emitido em jan e faturado em fev:
//       conta no ranking de Vendas em janeiro
//       conta no ranking de Faturamento em fevereiro
//
// Regras:
//   - C6_BLQ = ' '  (item nao bloqueado)
//   - C5_ZTIPO <> 'RED' (exclui redespacho)
//   - CFOPs de venda (mesma lista do ranking-faturamento)
//   - Valor = C6_QTDVEN * C6_PRCVEN * (1 + B1_IPI/100)
//   - Periodo aplicado em C5_EMISSAO (data do pedido)
//
// Retorna `bus[]` com todas as BUs do periodo (sem filtro de bu) pro dropdown
// ficar estavel, mesma estrategia do ranking-faturamento.

const CFOPS_VENDA = [
  '5101','5102','5103','5104','5105','5106','5109','5110','5111','5112','5113','5114','5115','5116','5117','5118','5119','5120','5122','5123','5129',
  '5251','5252','5253','5254','5255','5256','5257','5258',
  '5401','5402','5403','5405','5651','5652','5653','5654','5655','5656','5667','5932','5933',
  '6101','6102','6103','6104','6105','6106','6107','6108','6109','6110','6111','6112','6113','6114','6115','6116','6117','6118','6119','6120','6122','6123','6129',
  '6251','6252','6253','6254','6255','6256','6257','6258',
  '6401','6402','6403','6404','6651','6652','6653','6654','6655','6656','6667','6932','6933'
];

const toProtheusDate = (iso) => {
  if (!iso) return null;
  const s = String(iso).replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};

const EXPR_BU_LABEL = `COALESCE(NULLIF(RTRIM(bu_sx5.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO) + ' (Desconhecido)')`;

module.exports = (app) => ({
  verb: 'get',
  route: '/ranking-vendas',

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const { inicio, fim, vendedor, bu } = req.query;

    const dtInicio = toProtheusDate(inicio);
    const dtFim = toProtheusDate(fim);

    if (!dtInicio || !dtFim) {
      return res.status(400).json({ message: 'Parâmetros inicio e fim são obrigatórios (YYYY-MM-DD).' });
    }

    const metaTotal = Number(process.env.META_VENDAS_TOTAL || process.env.META_TOTAL || 6000000);

    const cfopList = CFOPS_VENDA.map(c => `'${c}'`).join(',');
    const condVendedor = vendedor
      ? `AND (sc5.C5_VEND1 = @vendedor OR sc5.C5_VEND2 = @vendedor OR sc5.C5_VEND3 = @vendedor)`
      : '';
    const condBu = bu ? `AND RTRIM(sc5.C5_ZTIPO) = @bu` : '';

    const joinBu = `
      LEFT JOIN SX5010 bu_sx5 WITH (NOLOCK)
        ON bu_sx5.X5_FILIAL = '  ' AND bu_sx5.X5_TABELA = 'Z1'
       AND RTRIM(bu_sx5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO)
       AND bu_sx5.D_E_L_E_T_ <> '*'
    `;

    // Soma por vendedor — todos os pedidos do periodo (qt total vendida * preco c/ IPI)
    // NAO filtra por saldo aberto: queremos TODOS os pedidos colocados no periodo,
    // faturados ou nao. Por isso este ranking nao bate com o de Faturamento (SD2/NF).
    const sql = `
      SELECT
        RTRIM(sc5.C5_VEND1) cod_vendedor,
        MAX(RTRIM(sa3.A3_NOME)) nome,
        CAST(SUM(sc6.C6_QTDVEN * sc6.C6_PRCVEN
                 * (1 + ISNULL(sb1.B1_IPI, 0) / 100.0)) AS DECIMAL(15,2)) total
      FROM SC6010 sc6 WITH (NOLOCK)
      LEFT JOIN SC5010 sc5 WITH (NOLOCK)
        ON sc5.C5_FILIAL = sc6.C6_FILIAL AND sc5.C5_NUM = sc6.C6_NUM
       AND sc5.D_E_L_E_T_ <> '*'
      LEFT JOIN SA3010 sa3 WITH (NOLOCK)
        ON sa3.A3_COD = sc5.C5_VEND1 AND sa3.D_E_L_E_T_ <> '*'
      LEFT JOIN SB1010 sb1 WITH (NOLOCK)
        ON sb1.B1_COD = sc6.C6_PRODUTO AND sb1.D_E_L_E_T_ <> '*'
      ${joinBu}
      WHERE sc6.D_E_L_E_T_ <> '*'
        AND sc6.C6_FILIAL = '01'
        AND sc5.C5_EMISSAO BETWEEN @inicio AND @fim
        AND sc6.C6_CF IN (${cfopList})
        AND sc6.C6_BLQ = ' '
        AND RTRIM(sc5.C5_ZTIPO) <> 'RED'
        ${condVendedor}
        ${condBu}
      GROUP BY sc5.C5_VEND1
      ORDER BY SUM(sc6.C6_QTDVEN * sc6.C6_PRCVEN
                  * (1 + ISNULL(sb1.B1_IPI, 0) / 100.0)) DESC
    `;

    // Lista BUs disponiveis no periodo (sem filtro de bu, pra dropdown estavel)
    const sqlBus = `
      SELECT ${EXPR_BU_LABEL} bu_label,
             RTRIM(MAX(sc5.C5_ZTIPO)) bu_codigo,
             SUM(sc6.C6_QTDVEN * sc6.C6_PRCVEN
                 * (1 + ISNULL(sb1.B1_IPI, 0) / 100.0)) total
      FROM SC6010 sc6 WITH (NOLOCK)
      LEFT JOIN SC5010 sc5 WITH (NOLOCK)
        ON sc5.C5_FILIAL = sc6.C6_FILIAL AND sc5.C5_NUM = sc6.C6_NUM
       AND sc5.D_E_L_E_T_ <> '*'
      LEFT JOIN SB1010 sb1 WITH (NOLOCK)
        ON sb1.B1_COD = sc6.C6_PRODUTO AND sb1.D_E_L_E_T_ <> '*'
      ${joinBu}
      WHERE sc6.D_E_L_E_T_ <> '*'
        AND sc6.C6_FILIAL = '01'
        AND sc5.C5_EMISSAO BETWEEN @inicio AND @fim
        AND sc6.C6_CF IN (${cfopList})
        AND sc6.C6_BLQ = ' '
        AND RTRIM(sc5.C5_ZTIPO) <> 'RED'
      GROUP BY ${EXPR_BU_LABEL}
      ORDER BY SUM(sc6.C6_QTDVEN * sc6.C6_PRCVEN
                  * (1 + ISNULL(sb1.B1_IPI, 0) / 100.0)) DESC
    `;

    try {
      const params = { inicio: dtInicio, fim: dtFim };
      if (vendedor) params.vendedor = String(vendedor);
      if (bu)       params.bu       = String(bu);

      const [rows, busRows] = await Promise.all([
        Protheus.connectAndQuery(sql, params),
        Protheus.connectAndQuery(sqlBus, { inicio: dtInicio, fim: dtFim })
      ]);

      const ranking = rows.map((r, i) => {
        const total = Number(r.total || 0);
        return {
          posicao: i + 1,
          cod_vendedor: (r.cod_vendedor || '').trim() || '??????',
          nome: (r.nome || '').trim() || 'Vendedor não identificado',
          total,
          percentualMetaTotal: metaTotal > 0 ? Number(((total / metaTotal) * 100).toFixed(2)) : 0
        };
      });

      const bus = busRows.map(r => ({
        codigo: (r.bu_codigo || '').trim(),
        label: (r.bu_label || '').trim(),
        total: Number(r.total || 0)
      }));

      return res.json({
        periodo: { inicio: dtInicio, fim: dtFim },
        metaTotal,
        filtroBu: bu ? String(bu) : null,
        bus,
        ranking
      });
    } catch (error) {
      console.error('Erro no ranking de vendas:', error);
      return res.status(500).json({ message: 'Erro ao consultar ranking de vendas.' });
    }
  }
});

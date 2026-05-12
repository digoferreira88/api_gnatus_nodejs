const CFOPS_FATURAMENTO = [
  '5105','5106','5116','5117','5119','5405','5933',
  '6105','6106','6107','6108','6109','6110','6116','6117',
  '6119','6122','6123','6404','6933'
];

const toProtheusDate = (iso) => {
  if (!iso) return null;
  const s = String(iso).replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};

// Label da BU: descricao da SX5 (X5_TABELA='Z1') ou "<cod> (Desconhecido)"
// — mesma logica do cobranca/equipes-ranking pra cruzamento bater.
const EXPR_BU_LABEL = `COALESCE(NULLIF(RTRIM(bu_sx5.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO) + ' (Desconhecido)')`;

module.exports = (app) => ({
  verb: 'get',
  route: '/ranking-faturamento',

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const { inicio, fim, vendedor, bu } = req.query;

    const dtInicio = toProtheusDate(inicio);
    const dtFim = toProtheusDate(fim);

    if (!dtInicio || !dtFim) {
      return res.status(400).json({ message: 'Parâmetros inicio e fim são obrigatórios (YYYY-MM-DD).' });
    }

    const metaTotal = Number(process.env.META_TOTAL || 130000000);

    const cfopList = CFOPS_FATURAMENTO.map(c => `'${c}'`).join(',');
    const condVendedor = vendedor
      ? `AND (sf2.f2_vend1 = @vendedor OR sf2.f2_vend2 = @vendedor OR sf2.f2_vend3 = @vendedor)`
      : '';
    const condBu = bu
      ? `AND RTRIM(sc5.C5_ZTIPO) = @bu`
      : '';

    // Join com SC5 (pedido) -> SX5 (descricao da BU). LEFT JOIN porque a NF
    // pode nao ter pedido vinculado em casos raros (manuais), e nesse caso a
    // venda ainda deve contar no ranking se nao houver filtro de BU.
    const joinPedidoBu = `
      LEFT JOIN SC5010 sc5 WITH (NOLOCK)
        ON sc5.C5_FILIAL = sd2.D2_FILIAL AND sc5.C5_NUM = sd2.D2_PEDIDO
       AND sc5.D_E_L_E_T_ <> '*'
      LEFT JOIN SX5010 bu_sx5 WITH (NOLOCK)
        ON bu_sx5.X5_FILIAL = '  ' AND bu_sx5.X5_TABELA = 'Z1'
       AND RTRIM(bu_sx5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO)
       AND bu_sx5.D_E_L_E_T_ <> '*'
    `;

    const sql = `
      SELECT
        sf2.f2_vend1 AS cod_vendedor,
        MAX(sa3.A3_NOME) AS nome,
        CAST(SUM(sd2.d2_valbrut - sd2.d2_valdev) AS DECIMAL(15,2)) AS total
      FROM dbo.Sf2010 sf2 WITH (NOLOCK)
      INNER JOIN Sd2010 sd2 WITH (NOLOCK)
        ON (sd2.D2_FILIAL = sf2.F2_FILIAL
            AND sd2.D2_DOC = sf2.f2_doc
            AND sd2.D2_SERIE = sf2.f2_serie
            AND sd2.D2_CLIENTE = sf2.F2_CLIENTE
            AND sd2.D2_LOJA = sf2.F2_LOJA)
      INNER JOIN sa3010 sa3 WITH (NOLOCK)
        ON (sf2.f2_vend1 = sa3.a3_cod AND sa3.D_E_L_E_T_ <> '*')
      ${joinPedidoBu}
      WHERE sf2.D_E_L_E_T_ <> '*'
        AND sf2.F2_FILIAL = '01'
        AND sf2.F2_EMISSAO >= @inicio
        AND sf2.F2_EMISSAO <= @fim
        AND sd2.D_E_L_E_T_ <> '*'
        AND sd2.d2_filial = '01'
        AND sd2.d2_emissao >= @inicio
        AND sd2.d2_emissao <= @fim
        AND sd2.D2_CF IN (${cfopList})
        ${condVendedor}
        ${condBu}
      GROUP BY sf2.f2_vend1
      ORDER BY SUM(sd2.d2_valbrut - sd2.d2_valdev) DESC
    `;

    // Lista de BUs disponiveis no periodo (sem aplicar o filtro de BU, pra que
    // o dropdown mostre todas as opcoes mesmo com filtro ativo).
    const sqlBus = `
      SELECT ${EXPR_BU_LABEL} AS bu_label,
             RTRIM(MAX(sc5.C5_ZTIPO)) AS bu_codigo,
             SUM(sd2.d2_valbrut - sd2.d2_valdev) AS total
        FROM dbo.Sf2010 sf2 WITH (NOLOCK)
        INNER JOIN Sd2010 sd2 WITH (NOLOCK)
          ON sd2.D2_FILIAL = sf2.F2_FILIAL
         AND sd2.D2_DOC    = sf2.f2_doc
         AND sd2.D2_SERIE  = sf2.f2_serie
         AND sd2.D2_CLIENTE= sf2.F2_CLIENTE
         AND sd2.D2_LOJA   = sf2.F2_LOJA
         AND sd2.D_E_L_E_T_ <> '*'
         AND sd2.D2_CF IN (${cfopList})
        ${joinPedidoBu}
       WHERE sf2.D_E_L_E_T_ <> '*'
         AND sf2.F2_FILIAL = '01'
         AND sf2.F2_EMISSAO >= @inicio
         AND sf2.F2_EMISSAO <= @fim
       GROUP BY ${EXPR_BU_LABEL}
       ORDER BY SUM(sd2.d2_valbrut - sd2.d2_valdev) DESC
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
          cod_vendedor: (r.cod_vendedor || '').trim(),
          nome: (r.nome || '').trim(),
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
      console.error('Erro no ranking de faturamento:', error);
      return res.status(500).json({ message: 'Erro ao consultar ranking de faturamento.' });
    }
  }
});

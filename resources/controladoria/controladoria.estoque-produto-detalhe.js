// GET /controladoria/estoque-produto/:cod
// Drill-down universal de 1 produto pra ser usado pelos 3 dashboards.
// Retorna ficha (B1) + saldo por armazem (B2 + NNR) + historico mensal (PG)
// + ultimas 10 compras (SD1) + ultimas 10 vendas (SD2).
//
// Permissao 11004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11004]);

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

const CFOPS_VENDA = [
  '5101','5102','5103','5104','5105','5106','5109','5110','5111','5112','5113','5114','5115','5116','5117','5118','5119','5120','5122','5123','5129',
  '5251','5252','5253','5254','5255','5256','5257','5258',
  '5401','5402','5403','5405','5651','5652','5653','5654','5655','5656','5667','5932','5933',
  '6101','6102','6103','6104','6105','6106','6107','6108','6109','6110','6111','6112','6113','6114','6115','6116','6117','6118','6119','6120','6122','6123','6129',
  '6251','6252','6253','6254','6255','6256','6257','6258',
  '6401','6402','6403','6404','6651','6652','6653','6654','6655','6656','6667','6932','6933'
];

module.exports = (app) => ({
  verb: 'get',
  route: '/estoque-produto/:cod',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const cod = trim(req.params.cod);
    if (!cod) return res.status(400).json({ message: 'Codigo obrigatorio.' });

    try {
      // 1) Ficha B1 + saldo por armazem (B2 + NNR)
      const [b1Rows, b2Rows, histRows] = await Promise.all([
        Protheus.connectAndQuery(`
          SELECT TOP 1
                 RTRIM(B1_COD)   codigo,
                 RTRIM(B1_DESC)  descricao,
                 RTRIM(B1_TIPO)  tipo,
                 RTRIM(B1_GRUPO) grupo,
                 RTRIM(B1_UM)    unidade,
                 B1_PE           lead_time_dias
            FROM SB1010 WITH (NOLOCK)
           WHERE D_E_L_E_T_ <> '*' AND B1_COD = @cod`,
          { cod }
        ),
        Protheus.connectAndQuery(`
          SELECT RTRIM(sb2.B2_LOCAL) armazem,
                 RTRIM(nnr.NNR_DESCRI) descricao,
                 sb2.B2_QATU  qtd,
                 sb2.B2_CM1   cm,
                 sb2.B2_VATU1 valor
            FROM SB2010 sb2 WITH (NOLOCK)
            LEFT JOIN NNR010 nnr WITH (NOLOCK)
              ON nnr.NNR_CODIGO = sb2.B2_LOCAL AND nnr.D_E_L_E_T_ <> '*'
           WHERE sb2.D_E_L_E_T_ <> '*' AND sb2.B2_COD = @cod
           ORDER BY sb2.B2_LOCAL`,
          { cod }
        ),
        Pg.connectAndQuery(`
          SELECT ano_mes,
                 SUM(qtd_estoque)    qtd_estoque,
                 SUM(valor_estoque)  valor_estoque,
                 SUM(qtd_saidas_mes) qtd_saidas
            FROM tab_estoque_snapshot_mensal
           WHERE cod_produto = @cod
           GROUP BY ano_mes
           ORDER BY ano_mes DESC
           LIMIT 12`,
          { cod }
        )
      ]);

      if (!b1Rows.length) {
        return res.status(404).json({ message: 'Produto nao encontrado.' });
      }
      const b1 = b1Rows[0];

      // 2) Ultimas 10 compras (SD1 + SF1)
      const compras = await Protheus.connectAndQuery(`
        SELECT TOP 10
               RTRIM(sd1.D1_DOC)     nf,
               RTRIM(sd1.D1_SERIE)   serie,
               RTRIM(sa2.A2_NREDUZ)  fornecedor,
               sf1.F1_EMISSAO        data,
               sd1.D1_QUANT          qtd,
               sd1.D1_VUNIT          vunit,
               sd1.D1_TOTAL          total
          FROM SD1010 sd1 WITH (NOLOCK)
          INNER JOIN SF1010 sf1 WITH (NOLOCK)
            ON sf1.F1_FILIAL  = sd1.D1_FILIAL
           AND sf1.F1_DOC     = sd1.D1_DOC
           AND sf1.F1_SERIE   = sd1.D1_SERIE
           AND sf1.F1_FORNECE = sd1.D1_FORNECE
           AND sf1.F1_LOJA    = sd1.D1_LOJA
           AND sf1.D_E_L_E_T_ <> '*'
          LEFT JOIN SA2010 sa2 WITH (NOLOCK)
            ON sa2.A2_COD  = sd1.D1_FORNECE
           AND sa2.A2_LOJA = sd1.D1_LOJA
           AND sa2.D_E_L_E_T_ <> '*'
         WHERE sd1.D_E_L_E_T_ <> '*'
           AND sd1.D1_COD = @cod
           AND sd1.D1_QUANT > 0
         ORDER BY sf1.F1_EMISSAO DESC, sd1.R_E_C_N_O_ DESC`,
        { cod }
      );

      // 3) Ultimas 10 vendas (SD2)
      const cfopList = CFOPS_VENDA.map(c => `'${c}'`).join(',');
      const vendas = await Protheus.connectAndQuery(`
        SELECT TOP 10
               RTRIM(sd2.D2_DOC)     nf,
               RTRIM(sd2.D2_SERIE)   serie,
               RTRIM(sa1.A1_NREDUZ)  cliente,
               sd2.D2_EMISSAO        data,
               sd2.D2_QUANT          qtd,
               sd2.D2_TOTAL          total
          FROM SD2010 sd2 WITH (NOLOCK)
          LEFT JOIN SA1010 sa1 WITH (NOLOCK)
            ON sa1.A1_COD  = sd2.D2_CLIENTE
           AND sa1.A1_LOJA = sd2.D2_LOJA
           AND sa1.D_E_L_E_T_ <> '*'
         WHERE sd2.D_E_L_E_T_ <> '*'
           AND sd2.D2_COD = @cod
           AND sd2.D2_CF IN (${cfopList})
           AND sd2.D2_QUANT > 0
         ORDER BY sd2.D2_EMISSAO DESC, sd2.R_E_C_N_O_ DESC`,
        { cod }
      );

      return res.json({
        produto: {
          codigo: trim(b1.codigo),
          descricao: trim(b1.descricao),
          tipo: trim(b1.tipo),
          grupo: trim(b1.grupo),
          unidade: trim(b1.unidade),
          lead_time_dias: N(b1.lead_time_dias)
        },
        saldoArmazens: b2Rows.map(r => ({
          armazem: trim(r.armazem),
          descricao: trim(r.descricao),
          qtd: N(r.qtd),
          cm: N(r.cm),
          valor: N(r.valor)
        })),
        historicoMensal: histRows.reverse().map(h => ({
          ano_mes: h.ano_mes,
          qtd_estoque: N(h.qtd_estoque),
          valor_estoque: N(h.valor_estoque),
          qtd_saidas: N(h.qtd_saidas)
        })),
        ultimasCompras: compras.map(c => ({
          data: trim(c.data),
          nf: `${trim(c.nf)}${c.serie ? '/' + trim(c.serie) : ''}`,
          fornecedor: trim(c.fornecedor),
          qtd: N(c.qtd),
          vunit: N(c.vunit),
          total: N(c.total)
        })),
        ultimasVendas: vendas.map(v => ({
          data: trim(v.data),
          nf: `${trim(v.nf)}${v.serie ? '/' + trim(v.serie) : ''}`,
          cliente: trim(v.cliente),
          qtd: N(v.qtd),
          total: N(v.total)
        }))
      });
    } catch (err) {
      console.error('estoque-produto-detalhe:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

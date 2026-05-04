// Itens sem Movimento: produtos com estoque parado X dias sem venda.
// Migrado de Vendas/reportAnaliseSemMovimento do intranet antigo.
//
// Usa views customizadas no Protheus (existem ha tempos):
//   itens_diassemvenda  (D2_COD, D2_EMISSAO, DIAS)
//   itens_saldoarmazem  (B2_COD, B2_LOCAL, disponivel, B2_CM1)
//   nnr010              (NNR_CODIGO, NNR_DESCRI)  -- descricao do armazem
//
// GET /vendas/itens-sem-movimento?dias=180&armazem=01

const trim = (v) => v == null ? null : String(v).trim();
const toN  = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/itens-sem-movimento',
  middlewares: [require('../../middlewares/requirePerm')(app)([2004, 2002])],

  handler: async (req, res) => {
    const { Protheus } = app.services;

    const dias    = Math.max(Number(req.query.dias || 180), 1);
    const armazem = trim(req.query.armazem);

    const params = { dias };
    let condArm = '';
    if (armazem) { condArm = 'AND st.B2_LOCAL = @arm'; params.arm = armazem; }

    try {
      const rows = await Protheus.connectAndQuery(`
        SELECT RTRIM(sb1.B1_COD) codigo,
               RTRIM(sb1.B1_DESC) descricao,
               RTRIM(sb1.B1_TIPO) tipo,
               isv.D2_EMISSAO ultimaVenda,
               isv.DIAS dias,
               RTRIM(st.B2_LOCAL) armazem,
               RTRIM(nn.NNR_DESCRI) armazemDesc,
               st.disponivel,
               st.B2_CM1 custoMedio,
               (st.B2_CM1 * st.disponivel) custoTotal
          FROM SB1010 sb1 WITH (NOLOCK)
          INNER JOIN itens_diassemvenda isv ON sb1.B1_COD = isv.D2_COD
          INNER JOIN itens_saldoarmazem st  WITH (NOLOCK) ON sb1.B1_COD = st.B2_COD
          LEFT  JOIN nnr010 nn WITH (NOLOCK) ON st.B2_LOCAL = nn.NNR_CODIGO AND nn.D_E_L_E_T_ <> '*'
         WHERE sb1.D_E_L_E_T_ <> '*'
           AND isv.DIAS > @dias
           AND st.disponivel > 0
           ${condArm}
         ORDER BY (st.B2_CM1 * st.disponivel) DESC, sb1.B1_COD, st.B2_LOCAL`,
        params
      );

      const itens = rows.map(r => ({
        codigo: trim(r.codigo),
        descricao: trim(r.descricao),
        tipo: trim(r.tipo),
        ultimaVenda: trim(r.ultimaVenda),
        diasSemVenda: toN(r.dias),
        armazem: trim(r.armazem),
        armazemDesc: trim(r.armazemDesc),
        disponivel: toN(r.disponivel),
        custoMedio: toN(r.custoMedio),
        custoTotal: toN(r.custoTotal)
      }));

      const totalCusto = itens.reduce((s, i) => s + i.custoTotal, 0);

      return res.json({
        filtro: { dias, armazem: armazem || null },
        total: itens.length,
        totalCustoEstoqueParado: Number(totalCusto.toFixed(2)),
        itens,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro vendas/itens-sem-movimento:', err);
      return res.status(500).json({
        message: 'Erro: ' + err.message + ' (verificar se as views itens_diassemvenda e itens_saldoarmazem existem no Protheus)'
      });
    }
  }
});

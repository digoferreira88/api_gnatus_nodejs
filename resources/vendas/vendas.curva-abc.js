// Curva ABC Faturamento por PRODUTO.
// Migrado de Planejamento/ajaxCurvaABC do intranet antigo.
//
// Logica:
//   - SD2010 + SB1010 no periodo, filtrado por CFOP de venda
//   - Para cada produto: vendas - devolucoes (proporcional ao d2_qtdedev)
//   - Ordena DESC por total, calcula % acumulado
//   - Categoria A: ate 80% acumulado
//   - Categoria B: 80-95% acumulado
//   - Categoria C: 95-100%
//
// GET /vendas/curva-abc?inicio=YYYY-MM-DD&fim=YYYY-MM-DD

const { getCfops, inLista } = require('./_cfops');

const toN = (v) => Number(v || 0);
const toProtData = (iso) => {
  const s = String(iso || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};

module.exports = (app) => ({
  verb: 'get',
  route: '/curva-abc',
  middlewares: [require('../../middlewares/requirePerm')(app)([2004, 2002])],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const inicio = toProtData(req.query.inicio);
    const fim    = toProtData(req.query.fim);
    if (!inicio || !fim) return res.status(400).json({ message: 'inicio e fim obrigatorios (YYYY-MM-DD).' });

    try {
      const cfops = await getCfops(Pg, 'faturamento');
      if (!cfops.length) return res.status(500).json({ message: 'Nenhum CFOP de faturamento configurado.' });

      const cfopList = inLista(cfops);

      // 1) Totais gerais (vendas, devolucoes, liquido)
      const totRows = await Protheus.connectAndQuery(`
        SELECT CAST(SUM(d2.D2_VALBRUT) AS DECIMAL(15,2)) AS vendas,
               CAST(SUM((CAST(d2.D2_VALBRUT AS DECIMAL(15,4))/NULLIF(d2.D2_QUANT,0))*d2.D2_QTDEDEV) AS DECIMAL(15,2)) AS devolucoes
          FROM SD2010 d2 WITH (NOLOCK)
         WHERE d2.D2_FILIAL = '01'
           AND d2.D2_EMISSAO BETWEEN @inicio AND @fim
           AND d2.D2_QUANT > 0
           AND d2.D_E_L_E_T_ <> '*'
           AND d2.D2_CF IN (${cfopList})`,
        { inicio, fim }
      );
      const vendas = toN(totRows[0]?.vendas);
      const devolucoes = toN(totRows[0]?.devolucoes);
      const totalLiquido = vendas - devolucoes;

      if (totalLiquido <= 0) {
        return res.json({
          periodo: { inicio, fim },
          totais: { vendas, devolucoes, totalLiquido },
          itens: [], resumo: { qtdA: 0, qtdB: 0, qtdC: 0, qtdTotal: 0 },
          aviso: 'Sem faturamento liquido no periodo.'
        });
      }

      // 2) Por produto, ordenado decrescente
      const itensRows = await Protheus.connectAndQuery(`
        SELECT RTRIM(d2.D2_COD) codigo,
               MAX(RTRIM(sb1.B1_DESC)) descricao,
               MAX(RTRIM(sb1.B1_TIPO)) tipo,
               SUM(d2.D2_QUANT) qtd,
               CAST(SUM(d2.D2_VALBRUT) AS DECIMAL(15,2)) vendas,
               CAST(SUM((CAST(d2.D2_VALBRUT AS DECIMAL(15,4))/NULLIF(d2.D2_QUANT,0))*d2.D2_QTDEDEV) AS DECIMAL(15,2)) devolucoes
          FROM SD2010 d2 WITH (NOLOCK)
          LEFT JOIN SB1010 sb1 WITH (NOLOCK) ON sb1.B1_COD = d2.D2_COD AND sb1.D_E_L_E_T_ <> '*'
         WHERE d2.D2_FILIAL = '01'
           AND d2.D2_EMISSAO BETWEEN @inicio AND @fim
           AND d2.D2_QUANT > 0
           AND d2.D_E_L_E_T_ <> '*'
           AND d2.D2_CF IN (${cfopList})
         GROUP BY d2.D2_COD
         ORDER BY (SUM(d2.D2_VALBRUT) - SUM((CAST(d2.D2_VALBRUT AS DECIMAL(15,4))/NULLIF(d2.D2_QUANT,0))*d2.D2_QTDEDEV)) DESC`,
        { inicio, fim }
      );

      // 3) Calcula % e categoria A/B/C com base no acumulado
      let acum = 0;
      let qtdA = 0, qtdB = 0, qtdC = 0;
      const itens = itensRows.map(r => {
        const total = toN(r.vendas) - toN(r.devolucoes);
        const perc = (total / totalLiquido) * 100;
        const acumAntes = acum;
        acum += perc;
        let categoria;
        if (acumAntes < 80)        { categoria = 'A'; qtdA++; }
        else if (acumAntes < 95)   { categoria = 'B'; qtdB++; }
        else                        { categoria = 'C'; qtdC++; }
        return {
          codigo: String(r.codigo).trim(),
          descricao: String(r.descricao || '').trim(),
          tipo: String(r.tipo || '').trim(),
          qtd: toN(r.qtd),
          vendas: toN(r.vendas),
          devolucoes: toN(r.devolucoes),
          total: Number(total.toFixed(2)),
          perc: Number(perc.toFixed(4)),
          percAcumulado: Number(acum.toFixed(4)),
          categoria
        };
      });

      return res.json({
        periodo: { inicio, fim },
        totais: { vendas, devolucoes, totalLiquido: Number(totalLiquido.toFixed(2)) },
        itens,
        resumo: { qtdA, qtdB, qtdC, qtdTotal: itens.length },
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro vendas/curva-abc:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

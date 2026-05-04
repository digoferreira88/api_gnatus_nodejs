// Carteira de Pedidos: pipeline de pedidos abertos por BU (C5_ZTIPO).
// Migrado de Vendas/ajaxCarteira do intranet antigo.
//
// Buckets de entrega (data prevista C6_ENTREG):
//   - atrasada:  < 1o dia do mes corrente
//   - mes_atual: dentro do mes corrente
//   - mes_p1:    proximo mes
//   - mes_p2:    daqui 2 meses
//   - futuro:    >= mes +3
//
// Saldo de cada pedido = (C6_QTDVEN - C6_QTDENT) * preco unitario com IPI
//
// GET /vendas/carteira?vendedor=000123

const { getCfops, inLista } = require('./_cfops');

const trim = (v) => v == null ? null : String(v).trim();
const toN  = (v) => Number(v || 0);

function buckets() {
  const hoje = new Date();
  const m0 = new Date(hoje.getFullYear(), hoje.getMonth(),     1);
  const m1 = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1);
  const m2 = new Date(hoje.getFullYear(), hoje.getMonth() + 2, 1);
  const m3 = new Date(hoje.getFullYear(), hoje.getMonth() + 3, 1);
  const fmt = (d) => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  return { m0: fmt(m0), m1: fmt(m1), m2: fmt(m2), m3: fmt(m3) };
}

module.exports = (app) => ({
  verb: 'get',
  route: '/carteira',
  middlewares: [require('../../middlewares/requirePerm')(app)([2004, 2002])],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const vendedor = trim(req.query.vendedor);

    try {
      const cfops = await getCfops(Pg, 'carteira');
      if (!cfops.length) return res.status(500).json({ message: 'Nenhum CFOP de carteira configurado.' });

      const { m0, m1, m2, m3 } = buckets();

      const condVend = vendedor
        ? `AND (sc5.C5_VEND1 = @vend OR sc5.C5_VEND2 = @vend OR sc5.C5_VEND3 = @vend)`
        : '';
      const params = { m0, m1, m2, m3 };
      if (vendedor) params.vend = vendedor;
      const cfopList = inLista(cfops);

      // Query mestre: agrupa por BU + bucket de entrega
      const sqlBucket = `
        SELECT RTRIM(sc5.C5_ZTIPO) bu,
               CASE
                 WHEN sc6.C6_ENTREG <  @m0 THEN 'atrasada'
                 WHEN sc6.C6_ENTREG <  @m1 THEN 'mes_atual'
                 WHEN sc6.C6_ENTREG <  @m2 THEN 'mes_p1'
                 WHEN sc6.C6_ENTREG <  @m3 THEN 'mes_p2'
                 ELSE 'futuro'
               END AS bucket,
               SUM(ROUND((sc6.C6_PRCVEN * (1 + (ISNULL(sb1.B1_IPI,0)/100))), 2)
                   * (ROUND(sc6.C6_QTDVEN,2) - ROUND(sc6.C6_QTDENT,2))) AS saldo,
               COUNT(DISTINCT sc6.C6_NUM) AS qtdPedidos
          FROM SC6010 sc6 WITH (NOLOCK)
          LEFT JOIN SC5010 sc5 WITH (NOLOCK) ON sc6.C6_NUM = sc5.C5_NUM
          LEFT JOIN SB1010 sb1 WITH (NOLOCK) ON sb1.B1_FILIAL = '' AND sb1.B1_COD = sc6.C6_PRODUTO AND sb1.D_E_L_E_T_ <> '*'
         WHERE sc6.C6_FILIAL = '01'
           AND sc6.D_E_L_E_T_ <> '*'
           AND sc5.D_E_L_E_T_ <> '*'
           AND sc6.C6_BLQ = ' '
           AND (sc6.C6_QTDVEN - sc6.C6_QTDENT) > 0
           AND sc6.C6_CF IN (${cfopList})
           ${condVend}
         GROUP BY sc5.C5_ZTIPO,
                  CASE
                    WHEN sc6.C6_ENTREG <  @m0 THEN 'atrasada'
                    WHEN sc6.C6_ENTREG <  @m1 THEN 'mes_atual'
                    WHEN sc6.C6_ENTREG <  @m2 THEN 'mes_p1'
                    WHEN sc6.C6_ENTREG <  @m3 THEN 'mes_p2'
                    ELSE 'futuro'
                  END`;

      const rows = await Protheus.connectAndQuery(sqlBucket, params);

      // Reorganiza em matriz BU -> { atrasada, mes_atual, mes_p1, mes_p2, futuro, total, qtdPedidos }
      const buMap = new Map();
      const totais = { atrasada: 0, mes_atual: 0, mes_p1: 0, mes_p2: 0, futuro: 0, total: 0 };
      let totalPedidos = 0;
      rows.forEach(r => {
        const bu = trim(r.bu) || '(sem BU)';
        const bucket = r.bucket;
        const valor = toN(r.saldo);
        if (!buMap.has(bu)) buMap.set(bu, { bu, atrasada: 0, mes_atual: 0, mes_p1: 0, mes_p2: 0, futuro: 0, total: 0 });
        const b = buMap.get(bu);
        b[bucket] += valor;
        b.total += valor;
        totais[bucket] += valor;
        totais.total   += valor;
        totalPedidos   += toN(r.qtdPedidos);
      });

      const linhas = Array.from(buMap.values()).sort((a, b) => b.total - a.total);

      return res.json({
        vendedor: vendedor || null,
        bucketsLabels: {
          atrasada:  'Atrasada',
          mes_atual: 'Mês atual',
          mes_p1:    'Mês +1',
          mes_p2:    'Mês +2',
          futuro:    'Mês +3 ou futuro'
        },
        linhas, totais,
        totalPedidos,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro vendas/carteira:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

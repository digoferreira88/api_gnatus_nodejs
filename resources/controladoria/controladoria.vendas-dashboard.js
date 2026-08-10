// GET /controladoria/vendas/dashboard?snapshot_mes=YYYYMM&segmento=geral|digital|varejo
// Reproduz o núcleo do relatório apresentado: faturamento mensal (Soma de Total Item
// CONSIDERADO) por ANO — a matriz mês × ano (comparativo YoY) + totais anuais. Mesmo
// número da tabela dinâmica (filtro em services/ctrlVendasRegras). Perm 11006.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11006, 0]);
const { SEGMENTOS, FORA } = require('../../services/ctrlVendasRegras');

module.exports = (app) => ({
  verb: 'get',
  route: '/vendas/dashboard',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const snap = /^\d{6}$/.test(String(req.query.snapshot_mes || '')) ? String(req.query.snapshot_mes) : null;
    const segKey = SEGMENTOS[String(req.query.segmento || 'geral').toLowerCase()] ? String(req.query.segmento).toLowerCase() : 'geral';
    if (!snap) return res.status(400).json({ message: 'snapshot_mes (YYYYMM) é obrigatório.' });
    const S = SEGMENTOS[segKey];

    try {
      const params = { snap };
      let filtro;
      if (S.incluir) { filtro = `tipo_considerar = ANY(@inc)`; params.inc = S.incluir; }
      else { filtro = `NOT (tipo_considerar = ANY(@fora))`; params.fora = S.excluir || FORA; }

      const rows = await Pg.connectAndQuery(`
        SELECT ano, EXTRACT(MONTH FROM emissao)::int mes, COALESCE(SUM(total_item), 0) tot,
               COUNT(DISTINCT pedido) pedidos
          FROM tab_ctrl_vendas_snapshot
         WHERE snapshot_mes = @snap AND emissao IS NOT NULL AND ${filtro}
         GROUP BY ano, mes ORDER BY ano, mes`, params);

      const anos = [...new Set(rows.map(r => Number(r.ano)))].filter(Boolean).sort();
      const meses = Array.from({ length: 12 }, (_, i) => ({ mes: i + 1, valores: {} }));
      const totaisAno = {};
      rows.forEach(r => {
        const ano = Number(r.ano), tot = Number(r.tot);
        if (r.mes >= 1 && r.mes <= 12) meses[r.mes - 1].valores[ano] = tot;
        totaisAno[ano] = (totaisAno[ano] || 0) + tot;
      });

      return res.json({ snapshotMes: snap, segmento: segKey, label: S.label, anos, meses, totaisAno, geradoEm: new Date().toISOString() });
    } catch (err) {
      console.error('controladoria/vendas-dashboard:', err);
      return res.status(500).json({ message: 'Erro ao montar o dashboard.' });
    }
  }
});

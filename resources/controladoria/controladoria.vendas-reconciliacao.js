// GET /controladoria/vendas/reconciliacao?snapshot_mes=YYYYMM&ano=YYYY
// Reconciliação de vendas a partir do snapshot: por mês de emissão, o bruto vs o
// CONSIDERADO (tirando o que a controladoria marcou como fora em "Tipo a considerar":
// Pedido Devolvido / Desconsiderar / Garantia/Troca / Redigitação) + a lista dos
// pedidos "fora" pra a controladoria conferir contra o que já foi apresentado. Perm 11006.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11006, 0]);

// Categorias de "Tipo a considerar" que NÃO contam como venda (saem do considerado).
const FORA = ['Pedido Devolvido', 'Desconsiderar', 'Garantia/Troca', 'Redigitação'];

module.exports = (app) => ({
  verb: 'get',
  route: '/vendas/reconciliacao',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const mes = /^\d{6}$/.test(String(req.query.snapshot_mes || '')) ? String(req.query.snapshot_mes) : null;
    const ano = /^\d{4}$/.test(String(req.query.ano || '')) ? Number(req.query.ano) : new Date().getFullYear();
    if (!mes) return res.status(400).json({ message: 'snapshot_mes (YYYYMM) é obrigatório.' });

    try {
      const resumo = await Pg.connectAndQuery(`
        SELECT to_char(emissao,'YYYY-MM') mes,
               COALESCE(SUM(total_item), 0)                                                          bruto,
               COALESCE(SUM(total_item) FILTER (WHERE tipo_considerar = ANY(@fora)), 0)              fora_total,
               COALESCE(SUM(total_item) FILTER (WHERE tipo_considerar = 'Pedido Devolvido'), 0)      devolvido,
               COALESCE(SUM(total_item) FILTER (WHERE tipo_considerar = 'Desconsiderar'), 0)         desconsiderar,
               COALESCE(SUM(total_item) FILTER (WHERE tipo_considerar = 'Garantia/Troca'), 0)        garantia,
               COALESCE(SUM(total_item) FILTER (WHERE tipo_considerar = 'Redigitação'), 0)           redigitacao,
               COUNT(DISTINCT pedido)                                                                qped,
               COUNT(DISTINCT pedido) FILTER (WHERE tipo_considerar = ANY(@fora))                    qped_fora
          FROM tab_ctrl_vendas_snapshot
         WHERE snapshot_mes = @mes AND ano = @ano AND emissao IS NOT NULL
         GROUP BY 1 ORDER BY 1`, { mes, ano, fora: FORA });

      resumo.forEach(r => { r.considerado = Number(r.bruto) - Number(r.fora_total); });

      const foraPedidos = await Pg.connectAndQuery(`
        SELECT to_char(MIN(emissao),'YYYY-MM') mes, pedido,
               MAX(tipo_considerar) tipo_considerar, MAX(cliente_nome) cliente_nome, MAX(nf) nf,
               COALESCE(SUM(total_item), 0) total
          FROM tab_ctrl_vendas_snapshot
         WHERE snapshot_mes = @mes AND ano = @ano AND tipo_considerar = ANY(@fora)
         GROUP BY pedido ORDER BY total DESC LIMIT 500`, { mes, ano, fora: FORA });

      return res.json({ snapshotMes: mes, ano, foraCategorias: FORA, resumo, foraPedidos, geradoEm: new Date().toISOString() });
    } catch (err) {
      console.error('controladoria/vendas-reconciliacao:', err);
      return res.status(500).json({ message: 'Erro ao montar a reconciliação.' });
    }
  }
});

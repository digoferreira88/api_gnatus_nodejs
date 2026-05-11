// GET /contratos/:id/reajuste-preview
// Calcula o reajuste sugerido baseado no indice cadastrado e no acumulado
// 12 meses ate hoje. Retorna percentual + novos valores SEM gravar.
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5002]);
const Bcb = require('../../services/bcbIndices');

module.exports = (app) => ({
  verb: 'get',
  route: '/:id/reajuste-preview',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    const mesesPeriodo = Math.min(Math.max(Number(req.query.meses || 12), 3), 36);
    try {
      const r = await Pg.connectAndQuery(`SELECT * FROM tab_contrato WHERE id = @id`, { id });
      if (!r.length) return res.status(404).json({ message: 'Contrato nao encontrado.' });
      const c = r[0];
      if (!c.indice_reajuste || c.indice_reajuste === 'NENHUM') {
        return res.status(400).json({ message: 'Contrato sem indice de reajuste cadastrado.' });
      }
      if (!c.valor_mensal && !c.valor_total) {
        return res.status(400).json({ message: 'Contrato sem valor_mensal ou valor_total — nao tem o que reajustar.' });
      }

      const variacao = await Bcb.variacaoAcumulada(c.indice_reajuste, mesesPeriodo);
      const novoMensal = c.valor_mensal ? Bcb.aplicarReajuste(Number(c.valor_mensal), variacao.percentual_acumulado) : null;
      const novoTotal  = c.valor_total  ? Bcb.aplicarReajuste(Number(c.valor_total),  variacao.percentual_acumulado) : null;

      return res.json({
        contrato_id: id,
        indice: c.indice_reajuste,
        periodo_referencia: { inicio: variacao.periodo_inicio, fim: variacao.periodo_fim, meses: variacao.meses_usados },
        percentual_acumulado: variacao.percentual_acumulado,
        fator: variacao.fator_multiplicador,
        valor_mensal_atual: Number(c.valor_mensal || 0),
        valor_mensal_novo:  novoMensal,
        delta_mensal: novoMensal != null ? Number((novoMensal - Number(c.valor_mensal || 0)).toFixed(2)) : null,
        valor_total_atual: Number(c.valor_total || 0),
        valor_total_novo:  novoTotal,
        delta_total: novoTotal != null ? Number((novoTotal - Number(c.valor_total || 0)).toFixed(2)) : null,
        serie: variacao.serie_detalhada
      });
    } catch (err) {
      console.error('reajuste-preview:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

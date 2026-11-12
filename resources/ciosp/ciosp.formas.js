// GET /ciosp/formas?edicao= — formas de pagamento da edição. Perm 19004/19001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 19001, 0]);

module.exports = (app) => ({
  verb: 'get',
  route: '/formas',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const edicao = String(req.query.edicao || '').trim();
    if (!edicao) return res.status(400).json({ message: 'Informe a edição.' });
    try {
      const rows = await app.services.Pg.connectAndQuery(
        `SELECT id, ordem, nome, coluna_base, desconto_pct, parcelas_max, exige_credito, financeira, ativo
           FROM tab_ciosp_forma_pagto WHERE edicao = @edicao ORDER BY ordem, nome`, { edicao });
      return res.json(rows.map(f => ({
        id: f.id, ordem: f.ordem, nome: f.nome, coluna_base: f.coluna_base, desconto_pct: Number(f.desconto_pct),
        parcelas_max: f.parcelas_max, exige_credito: !!f.exige_credito, financeira: !!f.financeira, ativo: !!f.ativo
      })));
    } catch (err) {
      console.error('ciosp/formas:', err.message);
      return res.status(500).json({ message: 'Erro ao listar formas de pagamento: ' + err.message });
    }
  }
});

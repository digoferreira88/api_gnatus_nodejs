// GET /expedicao/config — config do módulo Confirmação de Recebimento (liga/desliga,
// data de corte, expiração). Também informa se o template Suri está no .env. Perm 12003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([12003, 0]);

module.exports = (app) => ({
  verb: 'get',
  route: '/config',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const rows = await Pg.connectAndQuery(`SELECT chave, valor FROM tab_expedicao_config`, {});
      const cfg = {};
      rows.forEach((r) => { cfg[r.chave] = r.valor; });
      return res.json({
        ativo: cfg.ativo === true || cfg.ativo === 'true',
        dataInicio: cfg.dataInicio || null,
        expiraDias: Number(cfg.expiraDias ?? 15),
        mensagem: cfg.mensagem || {},
        templateConfigurado: !!String(process.env.SURI_TPL_EXPEDICAO || '').trim(),
        baseUrl: (process.env.EXPEDICAO_BASE_URL || process.env.NPS_BASE_URL || 'https://intranew.gnatus.com.br')
      });
    } catch (err) {
      console.error('expedicao/config GET:', err);
      return res.status(500).json({ message: 'Erro ao ler a configuração.' });
    }
  }
});

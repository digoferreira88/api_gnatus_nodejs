// GET /cobranca/whatsapp-config — retorna estado da automacao + ultimo disparo.
// Permissao 1030 (Tecnologia - Dashboard WhatsApp).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1030]);

module.exports = (app) => ({
  verb: 'get',
  route: '/whatsapp-config',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const cfg = await Pg.connectAndQuery(
        `SELECT chave, valor, atualizado_em FROM tab_cobranca_whatsapp_config`,
        {}
      );
      const map = {};
      cfg.forEach(c => { map[c.chave] = { valor: c.valor, atualizado_em: c.atualizado_em }; });

      const ultimo = await Pg.connectAndQuery(
        `SELECT MAX(criado_em) AS ultimo FROM tab_cobranca_whatsapp_envio`,
        {}
      );

      const stats = await Pg.connectAndQuery(`
        SELECT status, COUNT(*) qtd
          FROM tab_cobranca_whatsapp_envio
         WHERE disparo_em = CURRENT_DATE
         GROUP BY status`,
        {}
      );
      const statsHoje = { OK: 0, ERRO: 0, SEM_TELEFONE: 0, SKIP: 0 };
      stats.forEach(s => { statsHoje[s.status] = Number(s.qtd); });

      return res.json({
        automacao_ativa: String(map.automacao_ativa?.valor || 'false').toLowerCase() === 'true',
        atualizado_em: map.automacao_ativa?.atualizado_em || null,
        ultimo_envio: ultimo[0]?.ultimo || null,
        stats_hoje: statsHoje,
        cron: '09:00 (todo dia)',
        canal_id: app.services.Suri.CHANNEL_ID,
        templates: app.services.Suri.TEMPLATES
      });
    } catch (err) {
      console.error('whatsapp-config:', err);
      return res.status(500).json({ message: 'Erro ao consultar config.' });
    }
  }
});

// GET /cobranca/whatsapp-log — lista envios pra dashboard.
// Query params: data (YYYY-MM-DD), status, tipo, cliente, limit (default 200, max 1000).
// Permissao 1030.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1030]);

module.exports = (app) => ({
  verb: 'get',
  route: '/whatsapp-log',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;

    const limit  = Math.min(Math.max(Number(req.query.limit || 200), 1), 1000);
    const params = { lim: limit };
    const conds  = [];

    if (req.query.data && /^\d{4}-\d{2}-\d{2}$/.test(req.query.data)) {
      conds.push(`disparo_em = @data::date`);
      params.data = req.query.data;
    }
    if (req.query.status) {
      conds.push(`status = @status`);
      params.status = String(req.query.status).toUpperCase();
    }
    if (req.query.tipo) {
      conds.push(`tipo = @tipo`);
      params.tipo = String(req.query.tipo);
    }
    if (req.query.cliente) {
      conds.push(`(cliente_cod = @cli OR cliente_nome ILIKE '%' || @cli || '%')`);
      params.cli = String(req.query.cliente).toUpperCase();
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT id, filial, prefixo, numero, parcela,
               cliente_cod, cliente_loja, cliente_nome,
               tipo, telefone, template_nome, parametros,
               valor_titulo, vencimento,
               status, wamid, erro,
               criado_em, disparo_em
          FROM tab_cobranca_whatsapp_envio
          ${where}
         ORDER BY criado_em DESC
         LIMIT @lim`,
        params
      );

      const resumoSql = await Pg.connectAndQuery(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'OK')           AS ok,
          COUNT(*) FILTER (WHERE status = 'ERRO')         AS erro,
          COUNT(*) FILTER (WHERE status = 'SEM_TELEFONE') AS sem_telefone,
          COUNT(*) FILTER (WHERE status = 'SKIP')         AS skip,
          COUNT(*)                                        AS total
          FROM tab_cobranca_whatsapp_envio
          ${where}`,
        params
      );

      return res.json({
        envios: rows,
        resumo: resumoSql[0] || { ok: 0, erro: 0, sem_telefone: 0, skip: 0, total: 0 },
        filtros: {
          data: req.query.data || null,
          status: req.query.status || null,
          tipo: req.query.tipo || null,
          cliente: req.query.cliente || null
        }
      });
    } catch (err) {
      console.error('whatsapp-log:', err);
      return res.status(500).json({ message: 'Erro ao consultar log.' });
    }
  }
});

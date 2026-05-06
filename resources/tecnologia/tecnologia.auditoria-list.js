// GET /tecnologia/auditoria — lista logs com filtros (perm 1032).
// Query: ?modulo=&acao=&severidade=&usuario=&dataIni=&dataFim=&busca=&limit=N&offset=N

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1032]);

module.exports = (app) => ({
  verb: 'get',
  route: '/auditoria',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const limit  = Math.min(Math.max(Number(req.query.limit  || 200), 1), 1000);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const params = { lim: limit, off: offset };
    const conds = [];

    if (req.query.modulo)     { conds.push(`a.modulo = @modulo`); params.modulo = String(req.query.modulo); }
    if (req.query.submodulo)  { conds.push(`a.submodulo = @sub`); params.sub = String(req.query.submodulo); }
    if (req.query.acao)       { conds.push(`a.acao = @acao`); params.acao = String(req.query.acao); }
    if (req.query.severidade) { conds.push(`a.severidade = @sev`); params.sev = String(req.query.severidade); }
    if (req.query.usuario) {
      conds.push(`(a.id_usuario = @uid OR a.usuario_email ILIKE '%' || @uemail || '%' OR a.usuario_nome ILIKE '%' || @uemail || '%')`);
      params.uid = Number(req.query.usuario) || -1;
      params.uemail = String(req.query.usuario);
    }
    if (req.query.dataIni && /^\d{4}-\d{2}-\d{2}$/.test(req.query.dataIni)) {
      conds.push(`a.criado_em >= @ini::date`);
      params.ini = String(req.query.dataIni);
    }
    if (req.query.dataFim && /^\d{4}-\d{2}-\d{2}$/.test(req.query.dataFim)) {
      conds.push(`a.criado_em < (@fim::date + INTERVAL '1 day')`);
      params.fim = String(req.query.dataFim);
    }
    if (req.query.busca) {
      conds.push(`(a.descricao ILIKE '%' || @q || '%' OR a.entidade_id = @q)`);
      params.q = String(req.query.busca);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT a.id, a.modulo, a.submodulo, a.acao, a.severidade,
               a.id_usuario, a.usuario_email, a.usuario_nome, a.ip,
               a.entidade, a.entidade_id, a.descricao,
               a.criado_em,
               (a.antes IS NOT NULL OR a.depois IS NOT NULL OR a.meta IS NOT NULL) AS tem_detalhe
          FROM tab_auditoria a
          ${where}
         ORDER BY a.criado_em DESC, a.id DESC
         LIMIT @lim OFFSET @off`,
        params
      );

      const totalSql = await Pg.connectAndQuery(
        `SELECT COUNT(*) total FROM tab_auditoria a ${where}`, params
      );

      // KPIs do dia (independem dos filtros — visao geral)
      const kpis = await Pg.connectAndQuery(`
        SELECT
          COUNT(*) FILTER (WHERE criado_em::date = CURRENT_DATE)                          AS hoje_total,
          COUNT(*) FILTER (WHERE criado_em::date = CURRENT_DATE AND severidade = 'CRITICO') AS hoje_critico,
          COUNT(*) FILTER (WHERE criado_em::date = CURRENT_DATE AND severidade = 'ALERTA')  AS hoje_alerta,
          COUNT(DISTINCT id_usuario) FILTER (WHERE criado_em::date = CURRENT_DATE)         AS hoje_usuarios
          FROM tab_auditoria`, {}
      );

      return res.json({
        logs: rows,
        total: Number(totalSql[0]?.total || 0),
        kpis: kpis[0] || {},
        limite: limit, offset
      });
    } catch (err) {
      console.error('auditoria list:', err);
      return res.status(500).json({ message: 'Erro ao listar auditoria.' });
    }
  }
});

// GET /telefonia/linhas — lista linhas com filtros + KPIs do dashboard.
// Query: ?operadora=&status=&departamento=&busca=&vencendo=30&limit=&offset=
// Permissao 1027 (reusada — Tecnologia: Termo+Equipamentos+Linhas Moveis).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1027]);

module.exports = (app) => ({
  verb: 'get',
  route: '/linhas',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const limit  = Math.min(Math.max(Number(req.query.limit  || 500), 1), 5000);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    const conds = [];
    const params = { lim: limit, off: offset };
    if (req.query.operadora) {
      conds.push(`l.id_operadora = @op`);
      params.op = Number(req.query.operadora);
    }
    if (req.query.status) {
      conds.push(`l.status = @st`);
      params.st = String(req.query.status);
    }
    if (req.query.departamento) {
      conds.push(`l.id_departamento = @dep`);
      params.dep = Number(req.query.departamento);
    }
    if (req.query.busca) {
      conds.push(`(l.numero_telefone ILIKE '%' || @q || '%'
                OR l.pessoa          ILIKE '%' || @q || '%'
                OR l.plano           ILIKE '%' || @q || '%')`);
      params.q = String(req.query.busca);
    }
    if (req.query.vencendo) {
      const d = Number(req.query.vencendo) || 30;
      conds.push(`l.data_vencimento IS NOT NULL
              AND l.data_vencimento <= (CURRENT_DATE + (@dias || ' days')::interval)`);
      params.dias = String(d);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    try {
      const linhas = await Pg.connectAndQuery(`
        SELECT l.id, l.numero_telefone, l.plano, l.franquia_gb,
               l.pessoa, l.codigo_protheus, l.filial, l.centro_custo,
               l.data_ativacao, l.data_vencimento, l.status, l.observacoes,
               l.criado_em, l.atualizado_em,
               o.id AS id_operadora, o.nome AS operadora,
               c.id AS id_conta, c.numero_conta, c.numero_cliente, c.razao_social,
               d.id AS id_departamento, d.nome AS departamento,
               (l.data_vencimento IS NOT NULL AND l.data_vencimento <= CURRENT_DATE + INTERVAL '30 days')::int AS vencendo_30d
          FROM tab_telefonia_linha l
          JOIN tab_operadora o          ON o.id = l.id_operadora
          LEFT JOIN tab_telefonia_conta c        ON c.id = l.id_conta
          LEFT JOIN tab_telefonia_departamento d ON d.id = l.id_departamento
          ${where}
         ORDER BY o.nome, l.numero_telefone
         LIMIT @lim OFFSET @off`, params);

      const total = await Pg.connectAndQuery(
        `SELECT COUNT(*) total FROM tab_telefonia_linha l ${where}`, params
      );

      const kpis = await Pg.connectAndQuery(`
        SELECT
          COUNT(*)                                                   AS total,
          COUNT(*) FILTER (WHERE status = 'Ativa')                   AS ativas,
          COUNT(*) FILTER (WHERE status = 'Suspensa')                AS suspensas,
          COUNT(*) FILTER (WHERE status = 'Cancelada')               AS canceladas,
          COUNT(*) FILTER (WHERE status = 'EmEstoque')               AS estoque,
          COUNT(*) FILTER (WHERE status = 'Ativa' AND (pessoa IS NULL OR pessoa = '')) AS sem_titular,
          COUNT(*) FILTER (WHERE data_vencimento IS NOT NULL
                              AND data_vencimento <= CURRENT_DATE + INTERVAL '30 days'
                              AND status <> 'Cancelada')             AS vencendo_30d,
          COALESCE(SUM(franquia_gb) FILTER (WHERE status = 'Ativa'), 0) AS gb_total_ativas
          FROM tab_telefonia_linha`, {});

      const porOperadora = await Pg.connectAndQuery(`
        SELECT o.id, o.nome, COUNT(l.id) total,
               COUNT(*) FILTER (WHERE l.status = 'Ativa') ativas
          FROM tab_operadora o
          LEFT JOIN tab_telefonia_linha l ON l.id_operadora = o.id
         GROUP BY o.id, o.nome
         ORDER BY o.nome`, {});

      return res.json({
        linhas,
        total: Number(total[0]?.total || 0),
        kpis: kpis[0] || {},
        por_operadora: porOperadora,
        limit, offset
      });
    } catch (err) {
      console.error('telefonia/linhas list:', err);
      return res.status(500).json({ message: 'Erro ao listar linhas: ' + err.message });
    }
  }
});

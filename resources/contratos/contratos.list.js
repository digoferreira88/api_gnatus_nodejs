// GET /contratos — lista com filtros e KPIs leves
// Filtros: tipo, status, busca, contraparteCod, responsavel, vencendoEmDias, limit, offset
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5002]);
const Contratos = require('../../services/contratos');

module.exports = (app) => ({
  verb: 'get',
  route: '/',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const limit  = Math.min(Math.max(Number(req.query.limit  || 500), 1), 2000);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    const conds = [];
    const params = { lim: limit, off: offset };
    if (req.query.tipo)          { conds.push(`c.tipo = @tipo`); params.tipo = String(req.query.tipo); }
    if (req.query.contraparte)   { conds.push(`(c.contraparte_cod = @cc OR c.contraparte_cnpj = @cc OR UPPER(c.contraparte_nome) LIKE '%' || UPPER(@cc) || '%')`); params.cc = String(req.query.contraparte); }
    if (req.query.responsavel)   { conds.push(`c.id_user_responsavel = @uresp`); params.uresp = Number(req.query.responsavel); }
    if (req.query.busca) {
      conds.push(`(UPPER(c.titulo) LIKE '%' || UPPER(@q) || '%' OR UPPER(c.numero) LIKE '%' || UPPER(@q) || '%' OR UPPER(c.contraparte_nome) LIKE '%' || UPPER(@q) || '%')`);
      params.q = String(req.query.busca);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT c.*, u.nome AS responsavel_nome_user
          FROM tab_contrato c
          LEFT JOIN tab_intranet_usr u ON u.id = c.id_user_responsavel
          ${where}
         ORDER BY c.vigencia_fim NULLS LAST, c.criado_em DESC
         LIMIT @lim OFFSET @off`, params);

      // Enriquece com status calculado e dias_vencimento
      let contratos = rows.map(Contratos.enriquecer);

      // Filtro status / vencendoEmDias aplicado em runtime (status nao esta gravado)
      if (req.query.status) {
        const wanted = String(req.query.status).toUpperCase();
        contratos = contratos.filter(c => c.status === wanted);
      }
      if (req.query.vencendoEmDias) {
        const dias = Number(req.query.vencendoEmDias);
        contratos = contratos.filter(c => c.dias_para_vencimento != null && c.dias_para_vencimento >= 0 && c.dias_para_vencimento <= dias);
      }

      const total = await Pg.connectAndQuery(`SELECT COUNT(*) total FROM tab_contrato c ${where}`, params);
      return res.json({
        contratos,
        total: Number(total[0]?.total || 0),
        limit, offset
      });
    } catch (err) {
      console.error('contratos/list:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

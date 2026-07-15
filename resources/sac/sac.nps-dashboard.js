// GET /sac/nps/dashboard?inicio=&fim=
// Indicadores + dados dos gráficos da Pesquisa de Pós-venda. Perm 6003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6003]);
const N = (v) => Number(v || 0);
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/nps/dashboard',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const conds = [], p = {};
    if (trim(req.query.inicio)) { conds.push('c.criado_em >= @inicio'); p.inicio = trim(req.query.inicio); }
    if (trim(req.query.fim))    { conds.push('c.criado_em < (@fim::date + 1)'); p.fim = trim(req.query.fim); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    try {
      const tot = await Pg.connectAndQuery(`
        SELECT
          COUNT(*) enviados,
          COUNT(*) FILTER (WHERE status = 'RESPONDIDO') respondidos,
          COUNT(*) FILTER (WHERE classificacao = 'PROMOTOR') promotores,
          COUNT(*) FILTER (WHERE classificacao = 'NEUTRO')   neutros,
          COUNT(*) FILTER (WHERE classificacao = 'DETRATOR') detratores,
          AVG(nota_nps) FILTER (WHERE nota_nps IS NOT NULL)  media
        FROM tab_nps_convite c ${where}`, p);
      const t = tot[0] || {};
      const respondidos = N(t.respondidos);
      const promotores = N(t.promotores), detratores = N(t.detratores), neutros = N(t.neutros);
      const npsScore = respondidos > 0 ? Math.round(((promotores - detratores) / respondidos) * 100) : null;

      // distribuição por nota 0-10
      const dist = await Pg.connectAndQuery(`
        SELECT nota_nps nota, COUNT(*) qtd FROM tab_nps_convite c
        ${where ? where + ' AND' : 'WHERE'} nota_nps IS NOT NULL
        GROUP BY nota_nps ORDER BY nota_nps`, p);
      const distMap = new Map(dist.map(d => [N(d.nota), N(d.qtd)]));
      const distribuicao = Array.from({ length: 11 }, (_, i) => ({ nota: i, qtd: distMap.get(i) || 0 }));

      // evolução mensal (últimos 12 meses respondidos)
      const evo = await Pg.connectAndQuery(`
        SELECT to_char(date_trunc('month', respondido_em), 'YYYY-MM') mes,
               COUNT(*) FILTER (WHERE classificacao='PROMOTOR') promotores,
               COUNT(*) FILTER (WHERE classificacao='NEUTRO')   neutros,
               COUNT(*) FILTER (WHERE classificacao='DETRATOR') detratores,
               COUNT(*) total
          FROM tab_nps_convite c
         WHERE respondido_em IS NOT NULL ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
         GROUP BY 1 ORDER BY 1 DESC LIMIT 12`, p);
      const evolucao = evo.map(e => {
        const total = N(e.total);
        const nps = total > 0 ? Math.round(((N(e.promotores) - N(e.detratores)) / total) * 100) : 0;
        return { mes: e.mes, promotores: N(e.promotores), neutros: N(e.neutros), detratores: N(e.detratores), total, nps };
      }).reverse();

      return res.json({
        kpis: {
          enviados: N(t.enviados), respondidos,
          taxaResposta: N(t.enviados) > 0 ? +(respondidos / N(t.enviados) * 100).toFixed(1) : 0,
          promotores, neutros, detratores,
          media: t.media != null ? +N(t.media).toFixed(1) : null,
          npsScore
        },
        distribuicao,
        classificacao: [
          { nome: 'Promotores', valor: promotores, cor: '#1e7d4f' },
          { nome: 'Neutros', valor: neutros, cor: '#f5a500' },
          { nome: 'Detratores', valor: detratores, cor: '#c0392b' }
        ],
        evolucao,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('sac/nps-dashboard:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

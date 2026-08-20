// GET /cobranca/acoes-resumo — contagem das ações de follow-up PENDENTES do
// usuário logado (não concluídas, com promessa). Alimenta o lembrete no login.
// Leve de propósito: só COUNTs, sem enriquecer com Protheus.
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002, 9003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/acoes-resumo',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    try {
      const base = `data_promessa IS NOT NULL AND resultado IN ('PROMESSA_PAGAMENTO','ACORDO_FECHADO') AND concluido = false`;
      const rows = await Pg.connectAndQuery(
        `SELECT
           COUNT(*) FILTER (WHERE ${base}) AS pendentes,
           COUNT(*) FILTER (WHERE ${base} AND data_promessa <  CURRENT_DATE) AS atrasadas,
           COUNT(*) FILTER (WHERE ${base} AND data_promessa =  CURRENT_DATE) AS vencem_hoje
         FROM tab_cobranca_acao
        WHERE id_user = @uid`, { uid: user.ID });
      const r = rows[0] || {};
      return res.json({
        pendentes: Number(r.pendentes || 0),
        atrasadas: Number(r.atrasadas || 0),
        vencemHoje: Number(r.vencem_hoje || 0)
      });
    } catch (err) {
      console.error('Erro cobranca/acoes-resumo:', err);
      return res.status(500).json({ message: 'Erro ao resumir ações.' });
    }
  }
});

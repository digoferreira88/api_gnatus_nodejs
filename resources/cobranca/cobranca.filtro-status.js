// GET /cobranca/filtro-status — lê a config GLOBAL do "filtro escondido" de status
// (status a excluir quando a operadora liga o checkbox cego no dashboard) + a lista
// de status disponíveis (valor+rótulo) pra a tela de config renderizar.
// Perm 9005 (gestora) — operadoras NÃO precisam ler isto (o dashboard aplica sozinho).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9005, 0]);
const { STATUS_LIST } = require('../../services/cobrancaStatus');

module.exports = (app) => ({
  verb: 'get',
  route: '/filtro-status',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const rows = await Pg.connectAndQuery(
        `SELECT status_excluidos, atualizado_por, atualizado_em
           FROM tab_cobranca_filtro_status WHERE id = 1`, {});
      const row = rows[0] || {};
      let excluidos = row.status_excluidos;
      if (typeof excluidos === 'string') { try { excluidos = JSON.parse(excluidos); } catch { excluidos = []; } }
      if (!Array.isArray(excluidos)) excluidos = [];

      return res.json({
        statusExcluidos: excluidos,
        statusDisponiveis: STATUS_LIST,
        atualizadoPor: row.atualizado_por || null,
        atualizadoEm: row.atualizado_em || null
      });
    } catch (err) {
      console.error('cobranca/filtro-status GET:', err);
      return res.status(500).json({ message: 'Erro ao ler o filtro de status.' });
    }
  }
});

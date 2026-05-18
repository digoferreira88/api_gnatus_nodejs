// Lista todos os mapeamentos BU -> Equipe (substitui aba "apoio" da planilha).
// Tambem retorna a lista distinta de equipes pra autocomplete na UI.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002, 9003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/bu-equipe',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const rows = await Pg.connectAndQuery(
        `SELECT b.bu_codigo, b.equipe, b.atualizado_em,
                u.nome AS atualizado_por_nome
           FROM tab_cobranca_bu_equipe b
           LEFT JOIN tab_intranet_usr u ON u.id = b.atualizado_por
          ORDER BY b.bu_codigo`,
        {}
      );
      const equipes = [...new Set(rows.map(r => String(r.equipe || '').trim()).filter(Boolean))].sort();
      return res.json({
        mapeamentos: rows.map(r => ({
          buCodigo: String(r.bu_codigo || '').trim(),
          equipe:   String(r.equipe || '').trim(),
          atualizadoEm: r.atualizado_em,
          atualizadoPorNome: r.atualizado_por_nome || null
        })),
        equipes
      });
    } catch (err) {
      console.error('Erro cobranca/bu-equipe:list:', err);
      return res.status(500).json({ message: 'Erro ao listar mapeamentos.' });
    }
  }
});

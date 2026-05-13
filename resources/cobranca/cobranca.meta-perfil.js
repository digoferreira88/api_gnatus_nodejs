// GET /cobranca/meta-perfil
// Lista os 4 perfis com metas + quantas equipes mapeadas em cada um.
// Permissao 9001 (admin Cobranca).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001]);
const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/meta-perfil',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const [perfis, equipesPorPerfil] = await Promise.all([
        Pg.connectAndQuery(`
          SELECT perfil, meta_min_pct, meta_max_pct, tolerancia_zero, descricao, atualizado_em
            FROM tab_cobranca_meta_perfil
           ORDER BY perfil`, {}),
        Pg.connectAndQuery(`
          SELECT perfil, COUNT(DISTINCT equipe) qt_equipes, COUNT(*) qt_bus
            FROM tab_cobranca_bu_equipe
           WHERE perfil IS NOT NULL
           GROUP BY perfil`, {})
      ]);

      const mapEq = new Map(equipesPorPerfil.map(e => [trim(e.perfil), { qtEquipes: N(e.qt_equipes), qtBus: N(e.qt_bus) }]));

      return res.json({
        perfis: perfis.map(p => ({
          perfil: trim(p.perfil),
          meta_min_pct: N(p.meta_min_pct),
          meta_max_pct: N(p.meta_max_pct),
          tolerancia_zero: !!p.tolerancia_zero,
          descricao: p.descricao,
          atualizado_em: p.atualizado_em,
          qt_equipes: mapEq.get(trim(p.perfil))?.qtEquipes || 0,
          qt_bus:     mapEq.get(trim(p.perfil))?.qtBus     || 0
        }))
      });
    } catch (err) {
      console.error('cobranca/meta-perfil GET:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

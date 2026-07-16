// GET /sac/nps/admin — config atual + todas as perguntas (ativas e inativas) +
// status das dependências (template Suri / Octadesk). Perm 6003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6003]);
const NPS = require('../../services/npsPosvenda');
const Octadesk = require('../../services/octadesk');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/nps/admin',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const cfg = await NPS.lerConfig(Pg);
      const perguntas = await Pg.connectAndQuery(
        `SELECT id, ordem, texto, tipo, opcoes, class_map, obrigatoria, e_nps, ativa FROM tab_nps_pergunta ORDER BY ordem, id`, {});
      return res.json({
        config: cfg,
        perguntas: perguntas.map(p => ({
          id: p.id, ordem: p.ordem, texto: trim(p.texto), tipo: trim(p.tipo),
          opcoes: Array.isArray(p.opcoes) ? p.opcoes : [], classMap: p.class_map || {},
          obrigatoria: p.obrigatoria, eNps: p.e_nps, ativa: p.ativa
        })),
        dependencias: {
          suriTemplate: !!NPS.TPL_NPS(),
          octadesk: Octadesk.configurado(),
          baseUrl: NPS.BASE_PUBLICA()
        }
      });
    } catch (err) {
      console.error('sac/nps-admin:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

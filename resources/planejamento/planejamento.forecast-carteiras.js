// GET /planejamento/forecast/carteiras
// Lista as carteiras que o usuário pode ver (gestão=todas; vendedor=as dele) +
// o ano corrente e a config (rev/aberto). Perm 18001 (vendedor) ou 18002 (gestão).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([18001, 18002, 0]);
const Acesso = require('../../services/forecastAcesso');

module.exports = (app) => ({
  verb: 'get',
  route: '/forecast/carteiras',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    try {
      const gestao = await Acesso.ehGestao(Pg, user.ID);
      const carteiras = await Acesso.carteirasVisiveis(Pg, user.ID, gestao);
      const anoAtual = Number(req.query.ano) || new Date().getFullYear();
      const cfg = (await Pg.connectAndQuery(
        `SELECT ano, rev, TO_CHAR(data_rev,'YYYY-MM-DD') data_rev, aberto
           FROM tab_forecast_config WHERE ano = @a`, { a: anoAtual }))[0] || null;

      return res.json({
        gestao,
        anoAtual,
        config: cfg,
        aberto: cfg ? !!cfg.aberto : true,
        carteiras: carteiras.map(c => ({
          id: c.id, nome: c.nome, vendedorCods: c.vendedor_cods || '', ufs: c.ufs || '',
          usuarioId: c.usuario_id, consolidar: !!c.consolidar, ordem: c.ordem,
          temVendedor: !!String(c.vendedor_cods || '').trim()
        }))
      });
    } catch (err) {
      console.error('forecast/carteiras:', err);
      return res.status(500).json({ message: 'Erro ao listar carteiras.' });
    }
  }
});

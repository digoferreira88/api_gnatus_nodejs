// POST /gerencia/cc-orcamento
// Upsert de orcamento anual por centro de custo (UNIQUE cc_codigo, ano).
// Body: { cc_codigo, cc_descricao?, ano, valor_orcado, obs? }
//
// Como a feature do orcamento ainda nao esta integrada na UI principal, este
// endpoint serve a tela de configuracao (modal/painel).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10001]);
const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/cc-orcamento',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });

    const b = req.body || {};
    const cc_codigo    = trim(b.cc_codigo);
    const cc_descricao = trim(b.cc_descricao);
    const ano          = parseInt(b.ano, 10);
    const valor_orcado = Number(b.valor_orcado);
    const obs          = trim(b.obs) || null;

    if (!cc_codigo) return res.status(400).json({ message: 'cc_codigo obrigatorio.' });
    if (!ano || ano < 2000 || ano > 2100) {
      return res.status(400).json({ message: 'ano (YYYY) invalido.' });
    }
    if (!Number.isFinite(valor_orcado) || valor_orcado < 0) {
      return res.status(400).json({ message: 'valor_orcado deve ser >= 0.' });
    }

    try {
      const rows = await Pg.connectAndQuery(`
        INSERT INTO tab_centro_custo_orcamento
          (cc_codigo, cc_descricao, ano, valor_orcado, obs, criado_por, atualizado_por)
        VALUES (@cc, @desc, @ano, @valor, @obs, @uid, @uid)
        ON CONFLICT (cc_codigo, ano) DO UPDATE
          SET valor_orcado   = EXCLUDED.valor_orcado,
              cc_descricao   = COALESCE(EXCLUDED.cc_descricao, tab_centro_custo_orcamento.cc_descricao),
              obs            = EXCLUDED.obs,
              atualizado_por = EXCLUDED.atualizado_por,
              atualizado_em  = NOW()
        RETURNING id, cc_codigo, cc_descricao, ano, valor_orcado, obs, criado_em, atualizado_em`,
        { cc: cc_codigo, desc: cc_descricao || null, ano, valor: valor_orcado, obs, uid: user.ID });

      return res.json({ ok: true, orcamento: rows[0] });
    } catch (err) {
      console.error('cc-orcamento-salvar:', err);
      return res.status(500).json({ message: 'Erro ao salvar orcamento: ' + err.message });
    }
  }
});

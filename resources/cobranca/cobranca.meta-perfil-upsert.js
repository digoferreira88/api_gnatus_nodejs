// PUT /cobranca/meta-perfil/:perfil
// Body: { meta_min_pct, meta_max_pct, tolerancia_zero, descricao? }
// Permissao 9001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'put',
  route: '/meta-perfil/:perfil',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const perfil = trim(req.params.perfil);
    if (!perfil) return res.status(400).json({ message: 'Perfil obrigatorio.' });

    const b = req.body || {};
    const min = Math.max(0, Math.min(100, N(b.meta_min_pct)));
    const max = Math.max(min, Math.min(100, N(b.meta_max_pct)));
    const tz  = !!b.tolerancia_zero;
    const desc = trim(b.descricao) || null;

    try {
      const r = await Pg.connectAndQuery(`
        INSERT INTO tab_cobranca_meta_perfil (perfil, meta_min_pct, meta_max_pct, tolerancia_zero, descricao, atualizado_em)
        VALUES (@p, @min, @max, @tz, @desc, NOW())
        ON CONFLICT (perfil) DO UPDATE SET
          meta_min_pct = EXCLUDED.meta_min_pct,
          meta_max_pct = EXCLUDED.meta_max_pct,
          tolerancia_zero = EXCLUDED.tolerancia_zero,
          descricao = EXCLUDED.descricao,
          atualizado_em = NOW()
        RETURNING perfil, meta_min_pct, meta_max_pct, tolerancia_zero, descricao`,
        { p: perfil, min, max, tz, desc }
      );

      Auditoria.registrar(app, {
        modulo: 'Cobranca', submodulo: 'MetaPerfil',
        acao: 'UPSERT', severidade: 'INFO',
        req, entidade: 'cobranca_meta_perfil', entidadeId: perfil,
        descricao: `Atualizou meta do perfil ${perfil} (${min}%-${max}%, tolZero=${tz})`,
        meta: { perfil, min, max, tolerancia_zero: tz }
      });

      return res.json({ ok: true, perfil: r[0] });
    } catch (err) {
      console.error('cobranca/meta-perfil PUT:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

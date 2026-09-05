// PUT /ciosp/meta — define as metas da edição (alvos dos cartões "% Meta Geral"
// e "% Super Meta" + metas por categoria). Perm 19002. Upsert por edição.
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19002, 0]);
const Auditoria = require('../../services/auditoria');
const num = (v) => { const n = Number(String(v == null ? '' : v).toString().replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };

module.exports = (app) => ({
  verb: 'put',
  route: '/meta',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    const edicao = String(b.edicao || 'CIOSP 2026').trim().slice(0, 40);
    const campos = {
      ed: edicao,
      geral: num(b.metaGeral), sup: num(b.superMeta),
      eq: num(b.metaEquip), dg: num(b.metaDigital), at: num(b.metaAt)
    };
    try {
      await Pg.connectAndQuery(
        `INSERT INTO tab_ciosp_meta (edicao, meta_geral, super_meta, meta_equip, meta_digital, meta_at, atualizado_em)
         VALUES (@ed,@geral,@sup,@eq,@dg,@at,NOW())
         ON CONFLICT (edicao) DO UPDATE SET
           meta_geral=@geral, super_meta=@sup, meta_equip=@eq, meta_digital=@dg, meta_at=@at, atualizado_em=NOW()`,
        campos);
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Meta', acao: 'CONFIGURAR', severidade: 'INFO',
        req, entidade: 'meta', entidadeId: edicao,
        descricao: `Metas ${edicao}: geral R$ ${campos.geral} · super R$ ${campos.sup}`
      });
      return res.json({ ok: true, edicao });
    } catch (err) {
      console.error('ciosp/meta:', err.message);
      return res.status(500).json({ message: 'Erro ao salvar metas: ' + err.message });
    }
  }
});

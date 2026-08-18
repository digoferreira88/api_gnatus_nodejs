// POST /planejamento/forecast/carteira-salvar  (gestão — perm 18002/0)
// Ajusta o de-para de uma carteira: vendedor(es) Protheus, UFs, dono (usuário que
// edita, por e-mail) e se entra no consolidado. É como o gestor liga cada vendedor
// à sua carteira (pra o self-service funcionar) e corrige o mapeamento.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([18002, 0]);
const Auditoria = require('../../services/auditoria');

const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/forecast/carteira-salvar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const b = req.body || {};
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id inválido.' });

    // normaliza códigos de vendedor e UFs (CSV)
    const vendedorCods = trim(b.vendedorCods).split(',').map(s => s.trim()).filter(Boolean).join(',');
    const ufs = trim(b.ufs).toUpperCase().split(',').map(s => s.trim()).filter(s => /^[A-Z]{2}$/.test(s)).join(',');
    const consolidar = b.consolidar === true || b.consolidar === 'true' || b.consolidar === 1;

    try {
      const rows = await Pg.connectAndQuery(`SELECT * FROM tab_forecast_carteira WHERE id=@id`, { id });
      if (!rows.length) return res.status(404).json({ message: 'Carteira não encontrada.' });

      // resolve o dono por e-mail (vazio = limpa)
      let usuarioId = null;
      const email = trim(b.usuarioEmail).toLowerCase();
      if (email) {
        const u = await Pg.connectAndQuery(`SELECT id FROM tab_intranet_usr WHERE LOWER(email)=@e LIMIT 1`, { e: email });
        if (!u.length) return res.status(400).json({ message: `Usuário "${email}" não encontrado na intranet.` });
        usuarioId = u[0].id;
      }

      await Pg.connectAndQuery(
        `UPDATE tab_forecast_carteira
            SET vendedor_cods=@v, ufs=@u, usuario_id=@uid, consolidar=@c, atualizado_em=NOW()
          WHERE id=@id`,
        { v: vendedorCods, u: ufs, uid: usuarioId, c: consolidar, id });

      Auditoria.registrar(app, {
        modulo: 'Planejamento', submodulo: 'Forecast', acao: 'CARTEIRA_SALVAR', severidade: 'INFO', req,
        entidade: 'forecast_carteira', entidadeId: String(id),
        descricao: `Ajustou carteira "${trim(rows[0].nome)}" (vend=${vendedorCods || '—'} ufs=${ufs || 'todas'} dono=${email || '—'})`,
        meta: { id, vendedorCods, ufs, usuarioId, consolidar }
      });

      return res.json({ ok: true, id, vendedorCods, ufs, usuarioId, consolidar });
    } catch (err) {
      console.error('forecast/carteira-salvar:', err);
      return res.status(500).json({ message: 'Erro ao salvar a carteira.' });
    }
  }
});

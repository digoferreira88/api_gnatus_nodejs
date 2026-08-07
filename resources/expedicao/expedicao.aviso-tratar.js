// PUT /expedicao/avisos/:id/tratar — a expedição marca o aviso como tratado (ou
// reabre) e opcionalmente registra uma observação interna. Perm 12003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([12003, 0]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'put',
  route: '/avisos/:id/tratar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'ID inválido.' });

    const tratado = (req.body && req.body.tratado) !== false;   // default true
    const obs = trim(req.body && req.body.observacao).slice(0, 2000) || null;

    try {
      const r = await Pg.connectAndQuery(`
        UPDATE tab_expedicao_aviso
           SET tratado = @t,
               tratado_por = @uid,
               tratado_em  = CASE WHEN @t THEN NOW() ELSE NULL END,
               tratado_obs = @obs
         WHERE id = @id
         RETURNING id, pedido, tratado`,
        { t: tratado, uid: user ? user.ID : null, obs, id });
      if (!r.length) return res.status(404).json({ message: 'Aviso não encontrado.' });

      Auditoria.registrar(app, {
        modulo: 'Expedicao', submodulo: 'ConfirmacaoRecebimento', acao: 'UPDATE', severidade: 'INFO',
        req, entidade: 'expedicao_aviso', entidadeId: id,
        descricao: `${tratado ? 'Marcou como tratado' : 'Reabriu'} o aviso do pedido ${trim(r[0].pedido)}`,
        meta: { tratado, observacao: obs }
      });
      return res.json({ ok: true, ...r[0] });
    } catch (err) {
      console.error('expedicao/aviso-tratar:', err);
      return res.status(500).json({ message: 'Erro ao atualizar o aviso.' });
    }
  }
});

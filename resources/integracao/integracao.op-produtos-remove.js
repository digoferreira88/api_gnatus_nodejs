// DELETE /integracao/op-produtos/:codigo — remove um produto da lista da
// automacao OP -> Pipefy. Perm 1033.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1033]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'delete',
  route: '/op-produtos/:codigo',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const codigo = trim(req.params.codigo).toUpperCase();
    if (!codigo) return res.status(400).json({ message: 'Código obrigatório.' });
    try {
      const del = await Pg.connectAndQuery(
        `DELETE FROM tab_op_pipefy_produtos WHERE codigo = @cod RETURNING descricao`, { cod: codigo });
      if (!del.length) return res.status(404).json({ message: 'Produto não está na lista.' });

      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'IntegracaoOpPipedrive', acao: 'REMOVE_PRODUTO',
        severidade: 'ALERTA', req, entidade: 'produto', entidadeId: codigo,
        descricao: `Removeu produto ${codigo} da automação OP → Pipefy`,
        meta: { codigo }
      });
      return res.json({ ok: true, codigo });
    } catch (err) {
      console.error('Erro op-produtos-remove:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

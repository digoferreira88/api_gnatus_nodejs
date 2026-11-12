// DELETE /ciosp/formas/:id — exclui uma forma de pagamento. Perm 19004.
// (Quando orçamentos passarem a apontar para a forma — Entrega 2 —, forma em uso
// deverá ser desativada em vez de excluída.)

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const Auditoria = require('../../services/auditoria');
const Edicao = require('../../services/ciospEdicao');

module.exports = (app) => ({
  verb: 'delete',
  route: '/formas/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Id inválido.' });
    try {
      const rows = await Edicao.q(app, `DELETE FROM tab_ciosp_forma_pagto WHERE id = $1 RETURNING edicao, nome`, [id]);
      if (!rows.length) return res.status(404).json({ message: 'Forma de pagamento não encontrada.' });
      await Edicao.tocarVersao(app, rows[0].edicao);
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Formas de pagamento', acao: 'EXCLUIR', severidade: 'AVISO',
        req, entidade: 'forma_pagto', entidadeId: id, descricao: `${rows[0].edicao}: ${rows[0].nome}`
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('ciosp/formas (excluir):', err.message);
      return res.status(500).json({ message: 'Erro ao excluir a forma de pagamento: ' + err.message });
    }
  }
});

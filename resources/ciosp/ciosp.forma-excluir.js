// DELETE /ciosp/formas/:id — exclui uma forma de pagamento. Perm 19004.
// Forma que algum orçamento ou pedido já usa não pode sumir (o documento aponta para
// ela): é desativada — sai das listas de escolha e continua no histórico.

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
      const uso = await Edicao.q(app,
        `SELECT EXISTS (SELECT 1 FROM tab_ciosp_pedido WHERE forma_pagto_id = $1)
             OR EXISTS (SELECT 1 FROM tab_ciosp_orcamento WHERE forma_pagto_id = $1) AS em_uso`, [id]);
      const desativar = !!(uso[0] && uso[0].em_uso);
      const rows = desativar
        ? await Edicao.q(app, `UPDATE tab_ciosp_forma_pagto SET ativo = false WHERE id = $1 RETURNING edicao, nome`, [id])
        : await Edicao.q(app, `DELETE FROM tab_ciosp_forma_pagto WHERE id = $1 RETURNING edicao, nome`, [id]);
      if (!rows.length) return res.status(404).json({ message: 'Forma de pagamento não encontrada.' });
      await Edicao.tocarVersao(app, rows[0].edicao);
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Formas de pagamento', acao: desativar ? 'DESATIVAR' : 'EXCLUIR', severidade: 'AVISO',
        req, entidade: 'forma_pagto', entidadeId: id,
        descricao: `${rows[0].edicao}: ${rows[0].nome}${desativar ? ' (em uso: desativada)' : ''}`
      });
      return res.json({ ok: true, desativada: desativar });
    } catch (err) {
      console.error('ciosp/formas (excluir):', err.message);
      return res.status(500).json({ message: 'Erro ao excluir a forma de pagamento: ' + err.message });
    }
  }
});

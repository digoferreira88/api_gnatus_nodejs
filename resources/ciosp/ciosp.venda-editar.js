// PUT /ciosp/vendas/:id — edita uma venda do CIOSP. Perm 19002. Auditoria.
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19002, 0]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'put',
  route: '/vendas/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'id inválido.' });
    const { montarCampos } = require('../../services/ciospIngest');
    const { erro, campos } = montarCampos(req.body || {});
    if (erro) return res.status(400).json({ message: erro });

    try {
      const upd = await Pg.connectAndQuery(
        `UPDATE tab_ciosp_venda SET
            edicao=@edicao, categoria=@categoria, cliente=@cliente, cpf_cnpj=@cpf_cnpj,
            data_venda=@data_venda, vendedor=@vendedor, entrega=@entrega, uf=@uf,
            pagto_princ=@pagto_princ, pagto_compl=@pagto_compl, financiadora=@financiadora,
            situacao_fin=@situacao_fin, gerente=@gerente, origem=@origem, equipe=@equipe,
            valor=@valor, tabela=@tabela, equipamentos=@equipamentos, observacao=@observacao,
            observacao2=@observacao2, custo=@custo, atualizado_em=NOW()
          WHERE id=@id RETURNING id`,
        { ...campos, id });
      if (!upd.length) return res.status(404).json({ message: 'Venda não encontrada.' });

      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Vendas', acao: 'EDITAR', severidade: 'INFO',
        req, entidade: 'venda', entidadeId: String(id),
        descricao: `Editou venda CIOSP #${id} — ${campos.cliente} · R$ ${campos.valor}`
      });
      return res.json({ ok: true, id });
    } catch (err) {
      console.error('ciosp/venda-editar:', err.message);
      return res.status(500).json({ message: 'Erro ao editar venda: ' + err.message });
    }
  }
});

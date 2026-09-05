// POST /ciosp/vendas  — lança uma nova venda do CIOSP. Perm 19002. Auditoria.
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19002, 0]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'post',
  route: '/vendas',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const { montarCampos } = require('../../services/ciospIngest');
    const { erro, campos } = montarCampos(req.body || {});
    if (erro) return res.status(400).json({ message: erro });

    try {
      const ins = await Pg.connectAndQuery(
        `INSERT INTO tab_ciosp_venda
          (edicao, categoria, cliente, cpf_cnpj, data_venda, vendedor, entrega, uf,
           pagto_princ, pagto_compl, financiadora, situacao_fin, gerente, origem, equipe,
           valor, tabela, equipamentos, observacao, observacao2, custo, criado_por)
         VALUES (@edicao,@categoria,@cliente,@cpf_cnpj,@data_venda,@vendedor,@entrega,@uf,
                 @pagto_princ,@pagto_compl,@financiadora,@situacao_fin,@gerente,@origem,@equipe,
                 @valor,@tabela,@equipamentos,@observacao,@observacao2,@custo,@por)
         RETURNING id`,
        { ...campos, por: user?.id ? Number(user.id) : null });

      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Vendas', acao: 'CRIAR', severidade: 'INFO',
        req, entidade: 'venda', entidadeId: String(ins[0].id),
        descricao: `Lançou venda CIOSP (${campos.categoria}) — ${campos.cliente} · R$ ${campos.valor}`
      });
      return res.json({ ok: true, id: ins[0].id });
    } catch (err) {
      console.error('ciosp/venda-criar:', err.message);
      return res.status(500).json({ message: 'Erro ao lançar venda: ' + err.message });
    }
  }
});

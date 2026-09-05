// GET /ciosp/vendas?edicao=&categoria=&dia=&q=
// Lista as vendas lançadas (grade de digitação). Filtros opcionais por edição,
// categoria, dia do evento e busca livre (cliente/vendedor). Perm 19001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19001, 0]);
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/vendas',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const edicao = trim(req.query.edicao);
    const categoria = trim(req.query.categoria).toUpperCase();
    const dia = trim(req.query.dia);
    const q = trim(req.query.q);

    const cond = [];
    const p = {};
    if (edicao) { cond.push('edicao=@ed'); p.ed = edicao; }
    if (categoria) { cond.push('categoria=@cat'); p.cat = categoria; }
    if (dia) { cond.push('data_venda=@dia::date'); p.dia = dia; }
    if (q) { cond.push('(cliente ILIKE @q OR vendedor ILIKE @q OR equipe ILIKE @q OR cpf_cnpj ILIKE @q)'); p.q = `%${q}%`; }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';

    try {
      const rows = await Pg.connectAndQuery(
        `SELECT id, edicao, categoria, cliente, cpf_cnpj, data_venda, vendedor, entrega, uf,
                pagto_princ, pagto_compl, financiadora, situacao_fin, gerente, origem, equipe,
                valor, tabela, equipamentos, observacao, observacao2, custo, criado_em
           FROM tab_ciosp_venda ${where}
          ORDER BY data_venda DESC NULLS LAST, id DESC
          LIMIT 5000`, p);

      const docs = rows.map(r => ({
        id: r.id, edicao: r.edicao, categoria: r.categoria, cliente: r.cliente,
        cpfCnpj: trim(r.cpf_cnpj), dataVenda: r.data_venda ? new Date(r.data_venda).toISOString().slice(0, 10) : '',
        vendedor: trim(r.vendedor), entrega: trim(r.entrega), uf: trim(r.uf),
        pagtoPrinc: trim(r.pagto_princ), pagtoCompl: trim(r.pagto_compl), financiadora: trim(r.financiadora),
        situacaoFin: trim(r.situacao_fin), gerente: trim(r.gerente), origem: trim(r.origem),
        equipe: trim(r.equipe), valor: Number(r.valor || 0), tabela: trim(r.tabela),
        equipamentos: trim(r.equipamentos), observacao: trim(r.observacao), observacao2: trim(r.observacao2),
        custo: r.custo == null ? null : Number(r.custo)
      }));

      return res.json({ total: docs.length, docs });
    } catch (err) {
      console.error('ciosp/vendas:', err.message);
      return res.status(500).json({ message: 'Erro ao listar vendas: ' + err.message });
    }
  }
});

// GET /ciosp/pedidos?edicao=&situacao=&busca=&meus=1 — lista de pedidos. Perm 19001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19001, 19002, 0]);
const { trim, N } = require('../../services/ciospDocs');

module.exports = (app) => ({
  verb: 'get',
  route: '/pedidos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const p = { edicao: trim(req.query.edicao) || 'CIOSP 2026' };
    const cond = ['p.edicao = @edicao'];

    const situacao = trim(req.query.situacao);
    if (situacao) { cond.push('p.situacao = @situacao'); p.situacao = situacao; }
    if (trim(req.query.meus) === '1' && user?.id) {
      cond.push('p.vendedor_id = @vend'); p.vend = Number(user.id);
    }
    const busca = trim(req.query.busca);
    if (busca) {
      cond.push(`(p.cliente_nome ILIKE @busca OR p.cliente_doc LIKE @buscaDoc OR CAST(p.numero AS TEXT) = @buscaNum)`);
      p.busca = `%${busca}%`;
      p.buscaDoc = `%${busca.replace(/\D/g, '')}%`;
      p.buscaNum = busca.replace(/\D/g, '') || '-1';
    }

    try {
      const linhas = await Pg.connectAndQuery(
        `SELECT p.id, p.uuid, p.numero, p.cliente_nome, p.cliente_doc, p.cliente_uf,
                p.vendedor_nome, p.situacao, p.cond_pagto, p.parcelas, p.valor_parcela,
                p.total, p.total_prazo, p.acrescimo_norte, p.prazo_entrega,
                p.protheus_pedido, p.criado_em, p.atualizado_em,
                o.numero AS orcamento_numero, o.uuid AS orcamento_uuid,
                (SELECT COUNT(*) FROM tab_ciosp_pedido_item i WHERE i.pedido_id = p.id) itens
           FROM tab_ciosp_pedido p
           LEFT JOIN tab_ciosp_orcamento o ON o.id = p.orcamento_id
          WHERE ${cond.join(' AND ')}
          ORDER BY p.atualizado_em DESC
          LIMIT 200`, p);

      const totais = linhas.reduce((a, r) => ({
        quantidade: a.quantidade + 1,
        valor: a.valor + N(r.total),
        de_orcamento: a.de_orcamento + (r.orcamento_numero ? 1 : 0)
      }), { quantidade: 0, valor: 0, de_orcamento: 0 });

      return res.json({
        edicao: p.edicao,
        totais: { ...totais, valor: Number(totais.valor.toFixed(2)) },
        pedidos: linhas
      });
    } catch (err) {
      console.error('ciosp/pedidos:', err.message);
      return res.status(500).json({ message: 'Erro ao listar pedidos: ' + err.message });
    }
  }
});

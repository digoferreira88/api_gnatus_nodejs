// GET /ciosp/orcamentos?edicao=&situacao=&busca=&meus=1 — lista de orçamentos. Perm 19001.
//
// O vendedor abre a tela e precisa ver o que ele deixou em aberto; o supervisor
// precisa ver a equipe. Por isso `meus=1` filtra pelo usuário logado, e sem ele a
// lista é do evento inteiro (quem não tiver 19003 só deve usar com meus=1 na tela).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19001, 19002, 0]);
const { trim, N } = require('../../services/ciospDocs');

module.exports = (app) => ({
  verb: 'get',
  route: '/orcamentos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const p = { edicao: trim(req.query.edicao) || 'CIOSP 2026' };
    const cond = ['o.edicao = @edicao'];

    const situacao = trim(req.query.situacao);
    if (situacao) { cond.push('o.situacao = @situacao'); p.situacao = situacao; }

    if (trim(req.query.meus) === '1' && user?.id) {
      cond.push('o.vendedor_id = @vend'); p.vend = Number(user.id);
    }
    const busca = trim(req.query.busca);
    if (busca) {
      cond.push(`(o.cliente_nome ILIKE @busca OR o.cliente_doc LIKE @buscaDoc OR CAST(o.numero AS TEXT) = @buscaNum)`);
      p.busca = `%${busca}%`;
      p.buscaDoc = `%${busca.replace(/\D/g, '')}%`;
      p.buscaNum = busca.replace(/\D/g, '') || '-1';
    }

    try {
      const linhas = await Pg.connectAndQuery(
        `SELECT o.id, o.uuid, o.numero, o.edicao, o.cliente_nome, o.cliente_doc, o.cliente_uf,
                o.vendedor_nome, o.situacao, o.validade, o.total, o.total_desconto,
                o.criado_em, o.atualizado_em,
                (SELECT COUNT(*) FROM tab_ciosp_orcamento_item i WHERE i.orcamento_id = o.id) itens,
                p.numero AS pedido_numero, p.uuid AS pedido_uuid
           FROM tab_ciosp_orcamento o
           LEFT JOIN tab_ciosp_pedido p ON p.orcamento_id = o.id
          WHERE ${cond.join(' AND ')}
          ORDER BY o.atualizado_em DESC
          LIMIT 200`, p);

      const totais = linhas.reduce((a, r) => ({
        quantidade: a.quantidade + 1,
        valor: a.valor + N(r.total),
        convertidos: a.convertidos + (r.pedido_numero ? 1 : 0),
        valor_convertido: a.valor_convertido + (r.pedido_numero ? N(r.total) : 0)
      }), { quantidade: 0, valor: 0, convertidos: 0, valor_convertido: 0 });

      return res.json({
        edicao: p.edicao,
        totais: {
          ...totais,
          valor: Number(totais.valor.toFixed(2)),
          valor_convertido: Number(totais.valor_convertido.toFixed(2)),
          // A taxa de conversão é a pergunta número 1 do painel pedido no brief.
          conversao_pct: totais.quantidade ? Number(((totais.convertidos / totais.quantidade) * 100).toFixed(1)) : 0
        },
        orcamentos: linhas
      });
    } catch (err) {
      console.error('ciosp/orcamentos:', err.message);
      return res.status(500).json({ message: 'Erro ao listar orçamentos: ' + err.message });
    }
  }
});

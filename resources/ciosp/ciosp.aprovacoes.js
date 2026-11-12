// GET /ciosp/aprovacoes — pedidos de aprovação de desconto em aberto (edição ativa).
// Perm 19005 (gerente da equipe do evento: vê os vendedores dele) ou 19004/admin (vê
// todos — saída para vendedor sem gerente cadastrado).
//
// Para cada item: preço base, preço mínimo (promoção + desconto livre), praticado e
// quanto passou do mínimo — é o que o gerente precisa para decidir. Vai junto o hash
// da versão pedida: a decisão só vale para ela.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 19005, 0]);
const F = require('../../services/ciospFluxo');
const P = require('../../services/ciospPreco');
const O = require('../../services/ciospOrcamento');
const E = require('../../services/ciospEdicao');

const n2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);

module.exports = (app) => ({
  verb: 'get',
  route: '/aprovacoes',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const uid = Number(user?.ID ?? user?.id) || null;

    try {
      const cfg = await E.getConfig(app);
      if (!cfg.edicao) return res.json({ edicao: null, aprovacoes: [] });
      const todos = await F.temPerm(app, uid, [19004]);

      const params = { edicao: cfg.edicao, eu: uid || 0 };
      const os = await Pg.connectAndQuery(
        `SELECT o.id, o.uuid, o.numero, o.cliente_nome, o.cliente_doc, o.vendedor_id, o.vendedor_nome,
                o.tabela_comissao, o.forma_pagto_id, f.nome AS forma_nome, o.total_bruto, o.total_desconto, o.total,
                o.desconto_hash, o.desconto_solicitado_em, o.situacao
           FROM tab_ciosp_orcamento o
           LEFT JOIN tab_ciosp_forma_pagto f ON f.id = o.forma_pagto_id
           ${todos ? '' : `JOIN tab_ciosp_equipe e ON e.edicao = o.edicao AND e.usuario_id = o.vendedor_id AND e.ativo`}
          WHERE o.edicao = @edicao AND o.desconto_status = 'pendente' AND o.desconto_solicitado_em IS NOT NULL
            AND o.situacao IN ('rascunho', 'enviado')
            ${todos ? '' : 'AND e.gerente_id = @eu'}
          ORDER BY o.desconto_solicitado_em`, params);
      if (!os.length) return res.json({ edicao: cfg.edicao, aprovacoes: [] });

      const ids = os.map(o => o.id);
      const itens = await E.q(app,
        `SELECT i.orcamento_id, i.seq, i.preco_id, i.descricao, i.quantidade, i.preco_tabela, i.preco, i.total,
                i.promocao_pct, i.promocao_texto, i.promocao_condicional
           FROM tab_ciosp_orcamento_item i WHERE i.orcamento_id = ANY($1::int[]) ORDER BY i.orcamento_id, i.seq`, [ids]);
      const precoIds = [...new Set(itens.map(i => i.preco_id).filter(Boolean))];
      const linhas = new Map();
      if (precoIds.length) {
        for (const l of await E.q(app, `SELECT * FROM tab_ciosp_preco WHERE id = ANY($1::int[])`, [precoIds])) linhas.set(l.id, l);
      }
      const formaIds = [...new Set(os.map(o => o.forma_pagto_id).filter(Boolean))];
      const formas = new Map();
      if (formaIds.length) {
        for (const f of await E.q(app, `SELECT * FROM tab_ciosp_forma_pagto WHERE id = ANY($1::int[])`, [formaIds])) formas.set(f.id, f);
      }

      const aprovacoes = os.map(o => {
        const forma = formas.get(o.forma_pagto_id);
        return {
          uuid: o.uuid, numero: o.numero, cliente_nome: o.cliente_nome, vendedor_nome: o.vendedor_nome,
          tabela_comissao: o.tabela_comissao, forma_nome: o.forma_nome,
          total_bruto: n2(o.total_bruto), total_desconto: n2(o.total_desconto), total: n2(o.total),
          solicitado_em: o.desconto_solicitado_em, hash: o.desconto_hash,
          itens: itens.filter(i => i.orcamento_id === o.id).map(i => {
            const linha = linhas.get(i.preco_id);
            const ok = linha && forma && o.tabela_comissao;
            return {
              seq: i.seq, descricao: i.descricao, quantidade: Number(i.quantidade),
              base: ok ? P.precoBase(linha, o.tabela_comissao, forma) : n2(i.preco_tabela),
              minimo: ok ? P.precoMinimo(linha, o.tabela_comissao, forma, cfg) : null,
              praticado: n2(i.preco),
              alem_do_livre: ok ? O.alemDoLivre({ preco: i.preco }, linha, o.tabela_comissao, forma, cfg) : null,
              fora_da_tabela: !linha,
              promocao_texto: i.promocao_texto, promocao_condicional: !!i.promocao_condicional
            };
          })
        };
      });
      return res.json({ edicao: cfg.edicao, aprovacoes });
    } catch (err) {
      console.error('ciosp/aprovacoes:', err.message);
      return res.status(500).json({ message: 'Erro ao listar aprovações: ' + err.message });
    }
  }
});

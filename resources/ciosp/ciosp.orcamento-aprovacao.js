// POST /ciosp/orcamentos/:uuid/aprovacao — o vendedor pede ao gerente a aprovação do
// desconto. Perm 19002 / 19005 (o dono do orçamento).
//
// Só vale com desconto acima do livre (`pendente`). O pedido fica preso aos preços de
// AGORA (hash): se o vendedor mudar item, quantidade, preço, tabela ou forma, o pedido
// cai e precisa ser feito de novo (ver ciospOrcamento.estadoDesconto).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19002, 19005, 0]);
const D = require('../../services/ciospDocs');
const F = require('../../services/ciospFluxo');
const P = require('../../services/ciospPreco');
const { q } = require('../../services/ciospEdicao');

const EH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = (app) => ({
  verb: 'post',
  route: '/orcamentos/:uuid/aprovacao',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const uid = Number(user?.ID ?? user?.id) || null;
    const uuid = D.trim(req.params.uuid).toLowerCase();
    if (!EH_UUID.test(uuid)) return res.status(404).json({ message: 'Orçamento não encontrado.' });

    try {
      const so = await F.escopoVendedor(app, uid);
      const r = await Pg.withTransaction(async (db) => {
        const os = await q(db, `SELECT * FROM tab_ciosp_orcamento WHERE uuid = $1 FOR UPDATE`, [uuid]);
        const o = os[0];
        if (!o || (so && Number(o.vendedor_id) !== so)) return { status: 404, erro: 'Orçamento não encontrado.' };
        if (!['rascunho', 'enviado'].includes(o.situacao)) return { status: 409, erro: `Orçamento ${o.situacao}.` };
        if (o.desconto_status !== 'pendente') {
          return {
            status: 409,
            erro: o.desconto_status === 'livre' ? 'Este orçamento está dentro do desconto livre: não precisa do gerente.'
              : `O desconto já foi ${o.desconto_status} pelo gerente.`
          };
        }
        const itens = await q(db, `SELECT preco_id, quantidade, preco FROM tab_ciosp_orcamento_item WHERE orcamento_id = $1`, [o.id]);
        const hash = P.hashAprovacao({ itens, tabela: o.tabela_comissao, forma_id: o.forma_pagto_id });
        if (o.desconto_solicitado_em && o.desconto_hash === hash) return { o, ja: true, em: o.desconto_solicitado_em };
        const up = await q(db,
          `UPDATE tab_ciosp_orcamento SET desconto_solicitado_em = NOW(), desconto_hash = $2, atualizado_em = NOW()
            WHERE id = $1 RETURNING desconto_solicitado_em`, [o.id, hash]);
        return { o, ja: false, em: up[0].desconto_solicitado_em };
      });
      if (r.erro) return res.status(r.status).json({ message: r.erro });

      if (!r.ja) {
        await D.registrar(Pg, 'orcamento', r.o.id, 'solicitou_aprovacao', { para: `R$ ${r.o.total}`, usuarioId: uid });
      }
      return res.json({ ok: true, desconto_status: 'pendente', desconto_solicitado_em: r.em });
    } catch (err) {
      console.error('ciosp/orcamento-aprovacao:', err.message);
      return res.status(500).json({ message: 'Erro ao pedir a aprovação: ' + err.message });
    }
  }
});

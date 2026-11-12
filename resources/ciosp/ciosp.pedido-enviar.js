// POST /ciosp/pedidos/:uuid/enviar — o vendedor manda o pedido para a fila do ADM.
// Perm 19002 (intranet) ou 19005 (app do estande).
//
// Vale de rascunho ou devolvido. A data do PRIMEIRO envio é a data da venda no painel:
// reenviar depois de uma devolução não muda (a venda foi feita no dia do evento).
// Reenviar também tira o ADM anterior — o pedido volta para a fila de quem pegar.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19002, 19005, 0]);
const equipeAtiva = require('../../middlewares/ciospEquipeAtiva');
const Auditoria = require('../../services/auditoria');
const D = require('../../services/ciospDocs');
const F = require('../../services/ciospFluxo');
const Painel = require('../../services/ciospPainel');
const { q } = require('../../services/ciospEdicao');

module.exports = (app) => ({
  verb: 'post',
  route: '/pedidos/:uuid/enviar',
  middlewares: [requirePerm(app), equipeAtiva(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const uid = Number(user?.ID ?? user?.id) || null;
    const uuid = D.trim(req.params.uuid).toLowerCase();

    try {
      const so = await F.escopoVendedor(app, uid);
      const r = await Pg.withTransaction(async (db) => {
        const ped = await q(db, `SELECT * FROM tab_ciosp_pedido WHERE uuid = $1 FOR UPDATE`, [uuid]);
        if (!ped.length) return { status: 404, erro: 'Pedido não encontrado.' };
        const pedido = ped[0];
        if (so && Number(pedido.vendedor_id) !== so) return { status: 404, erro: 'Pedido não encontrado.' };

        const forma = pedido.forma_pagto_id
          ? (await q(db, `SELECT id, edicao, nome, parcelas_max, ativo FROM tab_ciosp_forma_pagto WHERE id = $1`,
            [pedido.forma_pagto_id]))[0] || null
          : null;
        const itens = await q(db, `SELECT COUNT(*)::int n FROM tab_ciosp_pedido_item WHERE pedido_id = $1`, [pedido.id]);

        const v = F.validarEnvio(pedido, { forma, qtdItens: itens[0].n });
        if (v.erro) return v;

        const upd = await q(db,
          `UPDATE tab_ciosp_pedido
              SET situacao = 'enviado', enviado_em = COALESCE(enviado_em, NOW()),
                  adm_responsavel = NULL, adm_assumiu_em = NULL,
                  atualizado_em = NOW(), atualizado_por = $2
            WHERE id = $1 RETURNING enviado_em`, [pedido.id, uid]);
        // Não deveria haver linha no painel antes do ADM conferir; garante a regra.
        await Painel.sincronizarPainel(db, pedido.id);
        return { pedido, enviado_em: upd[0].enviado_em };
      });

      if (r.erro) return res.status(r.status || 400).json({ message: r.erro });

      await D.registrar(Pg, 'pedido', r.pedido.id, 'enviou',
        { de: r.pedido.situacao, para: 'enviado', usuarioId: uid });
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Pedido', acao: 'ENVIAR', severidade: 'INFO',
        req, entidade: 'pedido', entidadeId: String(r.pedido.id),
        descricao: `Enviou ao ADM o pedido ${r.pedido.numero} — ${r.pedido.cliente_nome} · R$ ${r.pedido.total}`
      });
      return res.json({ ok: true, situacao: 'enviado', enviado_em: r.enviado_em });
    } catch (err) {
      console.error('ciosp/pedido-enviar:', err.message);
      return res.status(500).json({ message: 'Erro ao enviar o pedido: ' + err.message });
    }
  }
});

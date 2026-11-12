// POST /ciosp/aprovacoes/:uuid { decisao: 'aprovar'|'recusar', obs, hash } — o gerente
// decide o desconto. Perm 19005 (gerente do vendedor na equipe do evento) ou
// 19004/admin.
//
// A decisão vale para a versão que o gerente VIU: o `hash` que ele recebeu em
// GET /ciosp/aprovacoes tem que ser o do pedido em aberto. Se o vendedor mudou o
// orçamento depois, 409 — nada é aprovado às cegas.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 19005, 0]);
const D = require('../../services/ciospDocs');
const F = require('../../services/ciospFluxo');
const { q } = require('../../services/ciospEdicao');

const EH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = (app) => ({
  verb: 'post',
  route: '/aprovacoes/:uuid',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const uid = Number(user?.ID ?? user?.id) || null;
    const uuid = D.trim(req.params.uuid).toLowerCase();
    const b = req.body || {};
    const decisao = D.trim(b.decisao);
    const obs = D.trim(b.obs).slice(0, 300) || null;

    if (!EH_UUID.test(uuid)) return res.status(404).json({ message: 'Orçamento não encontrado.' });
    if (!['aprovar', 'recusar'].includes(decisao)) return res.status(400).json({ message: 'Decisão: aprovar ou recusar.' });
    if (decisao === 'recusar' && (!obs || obs.length < 5)) {
      return res.status(400).json({ message: 'Diga ao vendedor por que o desconto foi recusado.' });
    }

    try {
      const todos = await F.temPerm(app, uid, [19004]);
      const r = await Pg.withTransaction(async (db) => {
        const os = await q(db, `SELECT * FROM tab_ciosp_orcamento WHERE uuid = $1 FOR UPDATE`, [uuid]);
        const o = os[0];
        if (!o) return { status: 404, erro: 'Orçamento não encontrado.' };
        if (!todos) {
          const g = await q(db, `SELECT gerente_id FROM tab_ciosp_equipe WHERE edicao = $1 AND usuario_id = $2 AND ativo`,
            [o.edicao, o.vendedor_id]);
          if (!g.length || Number(g[0].gerente_id) !== uid) return { status: 403, erro: 'Este vendedor não é da sua equipe.' };
        }
        if (o.desconto_status !== 'pendente' || !o.desconto_solicitado_em) {
          return { status: 409, erro: 'Não há pedido de aprovação em aberto para este orçamento.' };
        }
        if (D.trim(b.hash) !== o.desconto_hash) {
          return { status: 409, erro: 'O vendedor alterou o orçamento; abra de novo.' };
        }
        const status = decisao === 'aprovar' ? 'aprovado' : 'recusado';
        await q(db,
          `UPDATE tab_ciosp_orcamento
              SET desconto_status = $2, desconto_por = $3, desconto_em = NOW(), desconto_obs = $4, atualizado_em = NOW()
            WHERE id = $1`, [o.id, status, uid, obs]);
        return { o, status };
      });
      if (r.erro) return res.status(r.status).json({ message: r.erro });

      await D.registrar(Pg, 'orcamento', r.o.id, r.status === 'aprovado' ? 'aprovou_desconto' : 'recusou_desconto',
        { para: obs || r.status, usuarioId: uid });
      return res.json({ ok: true, desconto_status: r.status });
    } catch (err) {
      console.error('ciosp/aprovacao-decidir:', err.message);
      return res.status(500).json({ message: 'Erro ao registrar a decisão: ' + err.message });
    }
  }
});

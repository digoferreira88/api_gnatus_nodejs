// POST /gerencia/cc-usuario/:idUser — SUBSTITUI o conjunto de centros de custo do
// DRE restrito (perm 10003) de um usuário. Body: { ccs: [{codigo, descricao}] }.
// Substituição (e não add/remove) porque é idempotente e a UI manda o estado final.
// Perm 1028 (Gestão de Usuários). Migration 88.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1028]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/cc-usuario/:idUser',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const idUser = Number(req.params.idUser);
    if (!idUser) return res.status(400).json({ message: 'idUser inválido.' });
    const lista = Array.isArray(req.body?.ccs) ? req.body.ccs : [];
    const ccs = [...new Map(
      lista.map(c => [trim(c.codigo), { codigo: trim(c.codigo), descricao: trim(c.descricao).slice(0, 120) }])
    ).values()].filter(c => c.codigo);

    try {
      // Substitui o conjunto: apaga e reinsere (poucos registros por usuário).
      await Pg.connectAndQuery(`DELETE FROM tab_dre_cc_usuario WHERE id_user = @id`, { id: idUser });
      for (const c of ccs) {
        await Pg.connectAndQuery(`
          INSERT INTO tab_dre_cc_usuario (id_user, cc_codigo, cc_descricao, criado_por)
          VALUES (@id, @cod, @descr, @por)
          ON CONFLICT (id_user, cc_codigo) DO UPDATE SET cc_descricao = EXCLUDED.cc_descricao`,
          { id: idUser, cod: c.codigo, descr: c.descricao || null, por: user?.ID || null });
      }
      Auditoria.registrar(app, {
        modulo: 'Gerencia', submodulo: 'DRE', acao: 'CC_VINCULO', severidade: 'INFO', req,
        entidade: 'dre_cc_usuario', entidadeId: String(idUser),
        descricao: `Definiu ${ccs.length} centro(s) de custo do DRE restrito para o usuário ${idUser}`,
        meta: { idUser, ccs: ccs.map(c => c.codigo) }
      });
      return res.json({ ok: true, qtd: ccs.length });
    } catch (err) {
      console.error('gerencia/cc-usuario POST:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

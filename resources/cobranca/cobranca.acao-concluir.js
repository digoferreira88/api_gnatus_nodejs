// PUT /cobranca/acao/:id/concluir  · body { concluido: bool }
// Marca (ou desmarca) uma ação de follow-up como CONCLUÍDA. Concluída sai da fila
// de pendentes e do lembrete do login. Só o autor (ou admin) pode concluir a sua.
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002, 9003]);

module.exports = (app) => ({
  verb: 'put',
  route: '/acao/:id/concluir',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'ID inválido.' });
    const b = req.body || {};
    const concluido = b.concluido === true || b.concluido === 'true' || b.concluido === 1;

    try {
      const existing = await Pg.connectAndQuery(`SELECT id_user FROM tab_cobranca_acao WHERE id = @id`, { id });
      if (!existing.length) return res.status(404).json({ message: 'Ação não encontrada.' });
      if (existing[0].id_user !== user.ID && user.EMAIL !== 'admin@gnatus.com.br') {
        return res.status(403).json({ message: 'Sem permissão para concluir esta ação.' });
      }

      await Pg.connectAndQuery(
        `UPDATE tab_cobranca_acao
            SET concluido    = @c,
                concluido_em  = CASE WHEN @c THEN NOW()      ELSE NULL END,
                concluido_por = CASE WHEN @c THEN @uid::int  ELSE NULL END
          WHERE id = @id`,
        { c: concluido, uid: user.ID, id });

      return res.json({ ok: true, concluido });
    } catch (err) {
      console.error('Erro cobranca/acao-concluir:', err);
      return res.status(500).json({ message: 'Erro ao concluir ação.' });
    }
  }
});

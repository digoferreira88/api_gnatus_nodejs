// POST /universidade/rh/registro/:id/anular — anula um registro lançado por engano.
// Registro de treinamento não se exclui (é evidência): fica anulado, com motivo, quem e quando.
// Body: { motivo }  Perm 15004/15003.

const { ESCREVER, requirePerm, txt, usuario, audit } = require('./_rh');

module.exports = (app) => ({
  verb: 'post',
  route: '/rh/registro/:id/anular',
  middlewares: [requirePerm(app, ESCREVER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const u = usuario(req);
    const id = Number(req.params.id);
    const motivo = txt(req.body?.motivo, 1000);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Registro inválido.' });
    if (!motivo || motivo.length < 5) return res.status(400).json({ message: 'Descreva o motivo da anulação (mín. 5 caracteres).' });

    const r = await Pg.connectAndQuery(`
      UPDATE tab_uni_registro SET anulado = TRUE, anulado_motivo = @m, anulado_por = @u, anulado_em = NOW()
       WHERE id = @id AND NOT anulado
      RETURNING id, colaborador_id, curso_id, data_realizacao::text AS data`, { m: motivo, u: u.ID || null, id });
    if (!r.length) return res.status(404).json({ message: 'Registro não encontrado ou já anulado.' });

    await audit(app, req, 'ANULAR', 'uni_registro', id,
      `Anulou o registro ${id} (colaborador ${r[0].colaborador_id}, curso ${r[0].curso_id}, ${r[0].data}): ${motivo}`, { motivo });
    return res.json({ ok: true });
  }
});

// POST /universidade/rh/requisito/:id/dispensa — dispensa (ou desfaz a dispensa de) um
// curso exigido para uma pessoa. Ex.: experiência comprovada, curso equivalente externo.
// Body: { dispensar: true|false, motivo }  Perm 15004/15003.

const { ESCREVER, requirePerm, txt, usuario, audit } = require('./_rh');

module.exports = (app) => ({
  verb: 'post',
  route: '/rh/requisito/:id/dispensa',
  middlewares: [requirePerm(app, ESCREVER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const u = usuario(req);
    const id = Number(req.params.id);
    const dispensar = req.body?.dispensar !== false;
    const motivo = txt(req.body?.motivo, 1000);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Requisito inválido.' });
    if (dispensar && (!motivo || motivo.length < 5)) return res.status(400).json({ message: 'Justifique a dispensa (mín. 5 caracteres).' });

    const r = await Pg.connectAndQuery(`
      UPDATE tab_uni_requisito
         SET dispensado = @d,
             dispensa_motivo = CASE WHEN @d THEN @m ELSE dispensa_motivo END,
             dispensado_por = CASE WHEN @d THEN @u ELSE dispensado_por END,
             dispensado_em = CASE WHEN @d THEN NOW() ELSE dispensado_em END,
             atualizado_em = NOW()
       WHERE id = @id
      RETURNING id, colaborador_id, curso_id`, { d: dispensar, m: motivo, u: u.ID || null, id });
    if (!r.length) return res.status(404).json({ message: 'Requisito não encontrado.' });

    await audit(app, req, dispensar ? 'DISPENSAR' : 'DESFAZER_DISPENSA', 'uni_requisito', id,
      `${dispensar ? 'Dispensou' : 'Desfez a dispensa de'} curso ${r[0].curso_id} p/ colaborador ${r[0].colaborador_id}` +
      (dispensar ? `: ${motivo}` : (motivo ? ` (${motivo})` : '')), { motivo });
    return res.json({ ok: true });
  }
});

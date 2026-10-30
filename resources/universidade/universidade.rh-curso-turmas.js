// POST /universidade/rh/curso/:id/turmas — diz quais turmas do módulo Treinamentos
// valem para este curso. A presença marcada nessas turmas passa a contar como
// evidência (vw_uni_evidencia) — nada é copiado, o dado continua no Treinamentos.
// Body: { treinamentoIds: [..], versaoId? }  Perm 15004/15003.

const { ESCREVER, requirePerm, int, audit } = require('./_rh');

module.exports = (app) => ({
  verb: 'post',
  route: '/rh/curso/:id/turmas',
  middlewares: [requirePerm(app, ESCREVER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const cursoId = Number(req.params.id);
    if (!Number.isInteger(cursoId) || cursoId <= 0) return res.status(400).json({ message: 'Curso inválido.' });
    const ids = [...new Set((Array.isArray(req.body?.treinamentoIds) ? req.body.treinamentoIds : [])
      .map(Number).filter(n => Number.isInteger(n) && n > 0))];
    const versaoId = int(req.body?.versaoId) || null;

    const c = await Pg.connectAndQuery(`SELECT codigo FROM tab_uni_curso WHERE id = @id`, { id: cursoId });
    if (!c.length) return res.status(404).json({ message: 'Curso não encontrado.' });
    if (versaoId) {
      const v = await Pg.connectAndQuery(`SELECT 1 FROM tab_uni_curso_versao WHERE id = @v AND curso_id = @c`, { v: versaoId, c: cursoId });
      if (!v.length) return res.status(400).json({ message: 'Versão não pertence a este curso.' });
    }

    await Pg.withTransaction(async (cli) => {
      await cli.query(
        `UPDATE tab_treina_treinamento SET curso_id = NULL, curso_versao_id = NULL
          WHERE curso_id = $1 AND NOT (id = ANY($2::int[]))`, [cursoId, ids]);
      if (ids.length) {
        await cli.query(
          `UPDATE tab_treina_treinamento SET curso_id = $1, curso_versao_id = $3 WHERE id = ANY($2::int[])`,
          [cursoId, ids, versaoId]);
      }
    });

    await audit(app, req, 'ALTERAR', 'uni_curso', cursoId,
      `Turmas do Treinamentos vinculadas ao curso ${c[0].codigo}: ${ids.length ? ids.join(', ') : 'nenhuma'}`, { treinamentoIds: ids, versaoId });
    return res.json({ ok: true });
  }
});

// Inicia uma tentativa de quiz. Se ja existir tentativa em aberto, retorna ela.
// POST /universidade/curso/:cursoId/quiz/iniciar

module.exports = (app) => ({
  verb: 'post',
  route: '/curso/:cursoId/quiz/iniciar',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });

    const cursoId = Number(req.params.cursoId);
    if (!Number.isInteger(cursoId) || cursoId <= 0) return res.status(400).json({ message: 'cursoId invalido.' });

    try {
      const qz = await Pg.connectAndQuery(
        `SELECT id, tentativas_max FROM tab_uni_quiz WHERE curso_id = @cid AND ativo = true`,
        { cid: cursoId }
      );
      if (!qz.length) return res.status(404).json({ message: 'Curso nao tem quiz.' });
      const quiz = qz[0];

      const matr = await Pg.connectAndQuery(
        `SELECT id FROM tab_uni_matricula WHERE user_id = @uid AND curso_id = @cid`,
        { uid: user.ID, cid: cursoId }
      );
      if (!matr.length) return res.status(403).json({ message: 'Voce nao esta matriculado.' });
      const matrId = matr[0].id;

      // Se tem tentativa em aberto, devolve ela
      const aberta = await Pg.connectAndQuery(`
        SELECT id FROM tab_uni_tentativa
         WHERE matricula_id = @mid AND quiz_id = @qid AND finalizada_em IS NULL
         ORDER BY iniciada_em DESC LIMIT 1`,
        { mid: matrId, qid: quiz.id }
      );
      if (aberta.length) {
        return res.json({ ok: true, tentativaId: aberta[0].id, jaAberta: true });
      }

      // Bloqueia se atingiu tentativas_max (so conta finalizadas)
      if (quiz.tentativas_max > 0) {
        const cnt = await Pg.connectAndQuery(`
          SELECT COUNT(*)::int total FROM tab_uni_tentativa
           WHERE matricula_id = @mid AND quiz_id = @qid AND finalizada_em IS NOT NULL`,
          { mid: matrId, qid: quiz.id }
        );
        if (Number(cnt[0].total) >= quiz.tentativas_max) {
          return res.status(409).json({ message: `Limite de ${quiz.tentativas_max} tentativas atingido.` });
        }
      }

      const ins = await Pg.connectAndQuery(
        `INSERT INTO tab_uni_tentativa (matricula_id, quiz_id) VALUES (@mid, @qid) RETURNING id`,
        { mid: matrId, qid: quiz.id }
      );
      return res.json({ ok: true, tentativaId: ins[0].id });
    } catch (err) {
      console.error('Erro universidade/quiz/iniciar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

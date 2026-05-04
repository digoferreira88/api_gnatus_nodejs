// Marca uma aula como concluida pelo usuario logado.
// POST /universidade/aula/:id/concluir
//
// Recalcula percent_progresso da matricula. Se 100% obrigatorias estiverem
// concluidas, marca matricula como 'concluido' e seta data_conclusao.

module.exports = (app) => ({
  verb: 'post',
  route: '/aula/:id/concluir',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });

    const aulaId = Number(req.params.id);
    if (!Number.isInteger(aulaId) || aulaId <= 0) return res.status(400).json({ message: 'ID invalido.' });

    try {
      // Acha a aula e o curso dela
      const aula = await Pg.connectAndQuery(
        `SELECT id, curso_id FROM tab_uni_aula WHERE id = @aid`, { aid: aulaId }
      );
      if (!aula.length) return res.status(404).json({ message: 'Aula nao encontrada.' });
      const cursoId = aula[0].curso_id;

      // Acha a matricula do usuario nesse curso
      const matr = await Pg.connectAndQuery(
        `SELECT id FROM tab_uni_matricula WHERE user_id = @uid AND curso_id = @cid`,
        { uid: user.ID, cid: cursoId }
      );
      if (!matr.length) return res.status(403).json({ message: 'Voce nao esta matriculado neste curso.' });
      const matrId = matr[0].id;

      // Marca como concluida (idempotente — ON CONFLICT DO NOTHING via UNIQUE)
      try {
        await Pg.connectAndQuery(
          `INSERT INTO tab_uni_progresso (matricula_id, aula_id) VALUES (@mid, @aid)
           ON CONFLICT (matricula_id, aula_id) DO NOTHING`,
          { mid: matrId, aid: aulaId }
        );
      } catch { /* idempotent */ }

      // Recalcula progresso. Conta aulas obrigatorias; se nenhuma estiver marcada
      // como obrigatoria (cenario comum quando admin esqueceu o checkbox), faz
      // fallback considerando TODAS as aulas — assim nao trava em 0%.
      const totObrig = await Pg.connectAndQuery(
        `SELECT COUNT(*)::int total FROM tab_uni_aula WHERE curso_id = @cid AND obrigatoria = true`,
        { cid: cursoId }
      );
      const totConcObrig = await Pg.connectAndQuery(
        `SELECT COUNT(*)::int total
           FROM tab_uni_progresso p
           INNER JOIN tab_uni_aula a ON a.id = p.aula_id
          WHERE p.matricula_id = @mid AND a.obrigatoria = true`,
        { mid: matrId }
      );

      let total = Number(totObrig[0].total || 0);
      let conc = Number(totConcObrig[0].total || 0);

      if (total === 0) {
        // Fallback: conta todas as aulas
        const totAll = await Pg.connectAndQuery(
          `SELECT COUNT(*)::int total FROM tab_uni_aula WHERE curso_id = @cid`, { cid: cursoId }
        );
        const totConcAll = await Pg.connectAndQuery(
          `SELECT COUNT(*)::int total FROM tab_uni_progresso p
             INNER JOIN tab_uni_aula a ON a.id = p.aula_id
            WHERE p.matricula_id = @mid`, { mid: matrId }
        );
        total = Number(totAll[0].total || 0);
        conc  = Number(totConcAll[0].total || 0);
      }
      const aulasOk = total > 0 && conc >= total;

      // Se o curso tem quiz, conclusao final exige aprovacao
      const qz = await Pg.connectAndQuery(
        `SELECT id FROM tab_uni_quiz WHERE curso_id = @cid AND ativo = true`,
        { cid: cursoId }
      );
      const temQuiz = qz.length > 0;
      let quizAprovado = false;
      if (temQuiz) {
        const apr = await Pg.connectAndQuery(`
          SELECT 1 FROM tab_uni_tentativa
           WHERE matricula_id = @mid AND quiz_id = @qid AND aprovado = true LIMIT 1`,
          { mid: matrId, qid: qz[0].id }
        );
        quizAprovado = apr.length > 0;
      }

      // Progresso: se tem quiz, media aulas (50%) + quiz (50%); senao so aulas
      const pctAulas = total > 0 ? (conc / total) * 100 : (temQuiz ? 0 : 100);
      const pctQuiz = quizAprovado ? 100 : 0;
      const pct = temQuiz ? (pctAulas + pctQuiz) / 2 : pctAulas;
      const concluiu = aulasOk && (!temQuiz || quizAprovado);

      await Pg.connectAndQuery(`
        UPDATE tab_uni_matricula
           SET percent_progresso = @pct,
               status = CASE WHEN @conc THEN 'concluido' WHEN @pct > 0 THEN 'em_andamento' ELSE 'matriculado' END,
               data_conclusao = CASE WHEN @conc AND data_conclusao IS NULL THEN NOW() ELSE data_conclusao END
         WHERE id = @mid`,
        { pct: Number(pct.toFixed(2)), conc: concluiu, mid: matrId }
      );

      return res.json({
        ok: true,
        progresso: Number(pct.toFixed(2)),
        concluiu,
        temQuiz,
        quizPendente: temQuiz && !quizAprovado && aulasOk
      });
    } catch (err) {
      console.error('Erro universidade/aula/concluir:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

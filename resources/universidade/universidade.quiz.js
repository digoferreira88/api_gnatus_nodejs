// Retorna o quiz de um curso (header + questoes + alternativas, SEM marcar correta).
// Tambem retorna minhas tentativas anteriores e estado atual (pode tentar / aprovado).
// GET /universidade/curso/:cursoId/quiz

module.exports = (app) => ({
  verb: 'get',
  route: '/curso/:cursoId/quiz',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const cursoId = Number(req.params.cursoId);
    if (!Number.isInteger(cursoId) || cursoId <= 0) return res.status(400).json({ message: 'cursoId invalido.' });

    try {
      const qz = await Pg.connectAndQuery(`
        SELECT id, curso_id, titulo, descricao, nota_minima, tentativas_max, embaralhar, ativo
          FROM tab_uni_quiz WHERE curso_id = @cid AND ativo = true`,
        { cid: cursoId }
      );
      if (!qz.length) return res.status(404).json({ message: 'Curso nao tem quiz.' });
      const quiz = qz[0];

      const questoes = await Pg.connectAndQuery(`
        SELECT id, ordem, enunciado, tipo, pontuacao
          FROM tab_uni_questao WHERE quiz_id = @qid ORDER BY ordem, id`,
        { qid: quiz.id }
      );

      const alternativas = questoes.length ? await Pg.connectAndQuery(`
        SELECT id, questao_id, ordem, texto
          FROM tab_uni_alternativa
         WHERE questao_id IN (${questoes.map((_, i) => `@q${i}`).join(',')})
         ORDER BY questao_id, ordem, id`,
        questoes.reduce((acc, q, i) => { acc[`q${i}`] = q.id; return acc; }, {})
      ) : [];

      // Agrupa alternativas por questao (oculta `correta` propositalmente)
      const altsPorQ = new Map();
      alternativas.forEach(a => {
        if (!altsPorQ.has(a.questao_id)) altsPorQ.set(a.questao_id, []);
        altsPorQ.get(a.questao_id).push({ id: a.id, ordem: a.ordem, texto: a.texto });
      });

      const questoesComAlts = questoes.map(q => ({
        ...q, alternativas: altsPorQ.get(q.id) || []
      }));

      // Minhas tentativas (so se logado e matriculado)
      let minhasTentativas = [];
      let podeTentar = true;
      let melhorNota = null;
      let aprovado = false;

      if (user) {
        const matr = await Pg.connectAndQuery(
          `SELECT id FROM tab_uni_matricula WHERE user_id = @uid AND curso_id = @cid`,
          { uid: user.ID, cid: cursoId }
        );
        if (matr.length) {
          minhasTentativas = await Pg.connectAndQuery(`
            SELECT id, iniciada_em, finalizada_em, nota, aprovado
              FROM tab_uni_tentativa
             WHERE matricula_id = @mid AND quiz_id = @qid
             ORDER BY iniciada_em DESC`,
            { mid: matr[0].id, qid: quiz.id }
          );
          const finalizadas = minhasTentativas.filter(t => t.finalizada_em);
          if (quiz.tentativas_max > 0 && finalizadas.length >= quiz.tentativas_max) podeTentar = false;
          aprovado = finalizadas.some(t => t.aprovado);
          if (finalizadas.length) melhorNota = finalizadas.reduce((m, t) => Math.max(m, Number(t.nota || 0)), 0);
          // Se tem tentativa em aberto (iniciada e nao finalizada), permite continuar
          const aberta = minhasTentativas.find(t => !t.finalizada_em);
          if (aberta) podeTentar = true;
        }
      }

      return res.json({
        quiz, questoes: questoesComAlts,
        minhasTentativas, podeTentar, aprovado, melhorNota
      });
    } catch (err) {
      console.error('Erro universidade/quiz:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// Avaliação de um curso, visão do aluno: cabeçalho, quantas questões terá, minhas tentativas
// e — SE houver tentativa em aberto — as questões sorteadas para ela (sem o gabarito).
// O banco de questões nunca vai inteiro para o aluno (o sorteio acontece ao iniciar).
// GET /universidade/curso/:cursoId/quiz

const Quiz = require('./_quiz');

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
        SELECT id, curso_id, titulo, descricao, nota_minima, tentativas_max, embaralhar, ativo,
               qtd_sorteio, embaralhar_alternativas
          FROM tab_uni_quiz WHERE curso_id = @cid AND ativo = true`,
        { cid: cursoId }
      );
      if (!qz.length) return res.status(404).json({ message: 'Curso nao tem quiz.' });
      const quiz = qz[0];
      const bancoQ = await Quiz.banco(Pg, quiz.id);
      const qtdQuestoes = quiz.qtd_sorteio && Number(quiz.qtd_sorteio) < bancoQ.length ? Number(quiz.qtd_sorteio) : bancoQ.length;

      let minhasTentativas = [];
      let podeTentar = true;
      let melhorNota = null;
      let aprovado = false;
      let questoes = [];
      let tentativaAberta = null;

      if (user) {
        const matr = await Pg.connectAndQuery(
          `SELECT id FROM tab_uni_matricula WHERE user_id = @uid AND curso_id = @cid`,
          { uid: user.ID, cid: cursoId }
        );
        if (matr.length) {
          minhasTentativas = await Pg.connectAndQuery(`
            SELECT id, iniciada_em, finalizada_em, nota, aprovado, questoes
              FROM tab_uni_tentativa
             WHERE matricula_id = @mid AND quiz_id = @qid
             ORDER BY iniciada_em DESC`,
            { mid: matr[0].id, qid: quiz.id }
          );
          const finalizadas = minhasTentativas.filter(t => t.finalizada_em);
          if (quiz.tentativas_max > 0 && finalizadas.length >= quiz.tentativas_max) podeTentar = false;
          aprovado = finalizadas.some(t => t.aprovado);
          if (finalizadas.length) melhorNota = finalizadas.reduce((m, t) => Math.max(m, Number(t.nota || 0)), 0);
          const aberta = minhasTentativas.find(t => !t.finalizada_em);
          if (aberta) {
            podeTentar = true;
            tentativaAberta = aberta.id;
            questoes = Quiz.montar(bancoQ, aberta.questoes, false);
          }
          minhasTentativas = minhasTentativas.map(({ questoes: _q, ...t }) => t);
        }
      }

      return res.json({
        quiz: { ...quiz, totalBanco: bancoQ.length },
        qtdQuestoes, questoes, tentativaAberta,
        minhasTentativas, podeTentar, aprovado, melhorNota
      });
    } catch (err) {
      console.error('Erro universidade/quiz:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

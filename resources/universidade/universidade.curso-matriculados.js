// Lista alunos matriculados num curso (visao do instrutor/admin).
// Inclui: status, % progresso, qtd aulas concluidas, melhor nota do quiz, tentativas.
//
// GET /universidade/curso/:id/matriculados
// Permissao: dono do curso (instrutor) ou admin (15003).

const { ehInstrutor, ehAdmin } = require('./_perms');

module.exports = (app) => ({
  verb: 'get',
  route: '/curso/:id/matriculados',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });
    if (!(await ehInstrutor(Pg, user.ID))) return res.status(403).json({ message: 'Sem permissao.' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalido.' });

    const c = await Pg.connectAndQuery(
      `SELECT id, instrutor_id, titulo FROM tab_uni_curso WHERE id = @id`, { id }
    );
    if (!c.length) return res.status(404).json({ message: 'Curso nao encontrado.' });
    if (Number(c[0].instrutor_id) !== Number(user.ID) && !(await ehAdmin(Pg, user.ID))) {
      return res.status(403).json({ message: 'Voce nao eh dono deste curso.' });
    }

    try {
      const totalAulas = await Pg.connectAndQuery(
        `SELECT COUNT(*)::int total FROM tab_uni_aula WHERE curso_id = @id`, { id }
      );
      const totalA = Number(totalAulas[0].total || 0);

      const quiz = await Pg.connectAndQuery(
        `SELECT id, nota_minima, tentativas_max FROM tab_uni_quiz WHERE curso_id = @id AND ativo = true`, { id }
      );
      const temQuiz = quiz.length > 0;
      const quizId = temQuiz ? quiz[0].id : null;

      const matriculados = await Pg.connectAndQuery(`
        SELECT m.id AS matricula_id,
               m.user_id,
               u.nome,
               u.email,
               u.matricula AS matricula_funcional,
               m.status,
               m.percent_progresso,
               m.data_matricula,
               m.data_conclusao,
               (SELECT COUNT(*) FROM tab_uni_progresso p
                  INNER JOIN tab_uni_aula a ON a.id = p.aula_id
                 WHERE p.matricula_id = m.id) AS aulas_concluidas,
               (SELECT MAX(nota) FROM tab_uni_tentativa t
                 WHERE t.matricula_id = m.id AND t.finalizada_em IS NOT NULL) AS melhor_nota,
               (SELECT COUNT(*)::int FROM tab_uni_tentativa t
                 WHERE t.matricula_id = m.id AND t.finalizada_em IS NOT NULL) AS tentativas_feitas,
               (SELECT EXISTS(
                  SELECT 1 FROM tab_uni_tentativa t
                   WHERE t.matricula_id = m.id AND t.aprovado = true)
               ) AS aprovado_quiz
          FROM tab_uni_matricula m
          INNER JOIN tab_intranet_usr u ON u.id = m.user_id
         WHERE m.curso_id = @id
         ORDER BY
           CASE m.status WHEN 'concluido' THEN 1 WHEN 'em_andamento' THEN 2 WHEN 'matriculado' THEN 3 ELSE 4 END,
           u.nome`,
        { id }
      );

      return res.json({
        curso: { id, titulo: c[0].titulo },
        totalAulas: totalA,
        temQuiz,
        quiz: temQuiz ? { id: quizId, notaMinima: Number(quiz[0].nota_minima), tentativasMax: Number(quiz[0].tentativas_max) } : null,
        total: matriculados.length,
        matriculados: matriculados.map(m => ({
          matriculaId: Number(m.matricula_id),
          userId: Number(m.user_id),
          nome: m.nome,
          email: m.email,
          matriculaFuncional: m.matricula_funcional,
          status: m.status,
          percentProgresso: Number(m.percent_progresso || 0),
          dataMatricula: m.data_matricula,
          dataConclusao: m.data_conclusao,
          aulasConcluidas: Number(m.aulas_concluidas || 0),
          melhorNota: m.melhor_nota != null ? Number(m.melhor_nota) : null,
          tentativasFeitas: Number(m.tentativas_feitas || 0),
          aprovadoQuiz: !!m.aprovado_quiz
        }))
      });
    } catch (err) {
      console.error('Erro universidade/matriculados:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

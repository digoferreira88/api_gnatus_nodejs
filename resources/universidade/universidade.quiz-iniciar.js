// Inicia uma tentativa de avaliação: sorteia as questões do banco (qtd_sorteio), embaralha a
// ordem e as alternativas conforme o quiz e grava o sorteio na tentativa. Se já existir
// tentativa em aberto, devolve ela (mesmas questões, mesma ordem).
// POST /universidade/curso/:cursoId/quiz/iniciar → { tentativaId, questoes (sem gabarito) }
// Sem matrícula no curso, matricula na hora (a avaliação pode ser de curso presencial).

const Quiz = require('./_quiz');

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
        `SELECT q.id, q.tentativas_max, q.qtd_sorteio, q.embaralhar, q.embaralhar_alternativas, c.ativo AS curso_ativo
           FROM tab_uni_quiz q JOIN tab_uni_curso c ON c.id = q.curso_id
          WHERE q.curso_id = @cid AND q.ativo = true`,
        { cid: cursoId }
      );
      if (!qz.length) return res.status(404).json({ message: 'Curso nao tem quiz.' });
      const quiz = qz[0];
      const bancoQ = await Quiz.banco(Pg, quiz.id);
      if (!bancoQ.length) return res.status(409).json({ message: 'A avaliação ainda não tem questões cadastradas.' });

      let matr = await Pg.connectAndQuery(
        `SELECT id FROM tab_uni_matricula WHERE user_id = @uid AND curso_id = @cid`,
        { uid: user.ID, cid: cursoId }
      );
      if (!matr.length) {
        if (!quiz.curso_ativo) return res.status(409).json({ message: 'Curso inativo.' });
        // Só matricula sozinho se o curso é público ou está na trilha (requisito) da pessoa.
        const libera = await Pg.connectAndQuery(`
          SELECT 1 FROM tab_uni_curso c WHERE c.id = @cid AND c.publico
          UNION ALL
          SELECT 1 FROM tab_uni_requisito r JOIN tab_uni_colaborador col ON col.id = r.colaborador_id
           WHERE r.curso_id = @cid AND r.ativo AND (col.user_id = @uid OR lower(col.email) = lower(@email))
          LIMIT 1`, { cid: cursoId, uid: user.ID, email: String(user.EMAIL || user.email || '') });
        if (!libera.length) return res.status(403).json({ message: 'Este curso não está na sua trilha. Fale com o RH.' });
        matr = await Pg.connectAndQuery(
          `INSERT INTO tab_uni_matricula (user_id, curso_id) VALUES (@uid, @cid)
           ON CONFLICT (user_id, curso_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING id`,
          { uid: user.ID, cid: cursoId });
      }
      const matrId = matr[0].id;

      const aberta = await Pg.connectAndQuery(`
        SELECT id, questoes FROM tab_uni_tentativa
         WHERE matricula_id = @mid AND quiz_id = @qid AND finalizada_em IS NULL
         ORDER BY iniciada_em DESC LIMIT 1`,
        { mid: matrId, qid: quiz.id }
      );
      if (aberta.length) {
        return res.json({ ok: true, tentativaId: aberta[0].id, jaAberta: true, questoes: Quiz.montar(bancoQ, aberta[0].questoes, false) });
      }

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

      const sorteio = Quiz.sortear(quiz, bancoQ);
      const ins = await Pg.connectAndQuery(
        `INSERT INTO tab_uni_tentativa (matricula_id, quiz_id, questoes) VALUES (@mid, @qid, @sorteio::jsonb) RETURNING id`,
        { mid: matrId, qid: quiz.id, sorteio: JSON.stringify(sorteio) }
      );
      return res.json({ ok: true, tentativaId: ins[0].id, questoes: Quiz.montar(bancoQ, sorteio, false) });
    } catch (err) {
      console.error('Erro universidade/quiz/iniciar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

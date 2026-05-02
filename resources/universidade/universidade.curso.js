// Detalhe de um curso: header + aulas + minha matricula (se houver) + progresso por aula.
// GET /universidade/curso/:id

module.exports = (app) => ({
  verb: 'get',
  route: '/curso/:id',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalido.' });

    try {
      const cursoRows = await Pg.connectAndQuery(`
        SELECT c.*, cat.nome AS categoria_nome, cat.cor AS categoria_cor,
               u.nome AS instrutor_nome_atual
          FROM tab_uni_curso c
          LEFT JOIN tab_uni_categoria cat ON cat.id = c.categoria_id
          LEFT JOIN tab_intranet_usr u    ON u.id = c.instrutor_id
         WHERE c.id = @id`, { id });
      if (!cursoRows.length) return res.status(404).json({ message: 'Curso nao encontrado.' });

      const aulas = await Pg.connectAndQuery(`
        SELECT id, ordem, titulo, descricao, conteudo_url, tipo, duracao_min, obrigatoria
          FROM tab_uni_aula
         WHERE curso_id = @id
         ORDER BY ordem, id`, { id });

      // Minha matricula + progresso (se logado)
      let matricula = null, aulasConcluidas = [];
      if (user) {
        const mr = await Pg.connectAndQuery(`
          SELECT id, status, percent_progresso, data_matricula, data_conclusao
            FROM tab_uni_matricula
           WHERE user_id = @uid AND curso_id = @id`,
          { uid: user.ID, id }
        );
        if (mr.length) {
          matricula = mr[0];
          const pr = await Pg.connectAndQuery(`
            SELECT aula_id, concluido_em FROM tab_uni_progresso WHERE matricula_id = @mid`,
            { mid: matricula.id }
          );
          aulasConcluidas = pr;
        }
      }

      const setConcluidas = new Set(aulasConcluidas.map(p => p.aula_id));
      const aulasComProgresso = aulas.map(a => ({ ...a, concluida: setConcluidas.has(a.id) }));

      // Quiz info (se existir)
      const qzRows = await Pg.connectAndQuery(
        `SELECT id, titulo, descricao, nota_minima, tentativas_max
           FROM tab_uni_quiz WHERE curso_id = @id AND ativo = true`, { id }
      );
      let quiz = null;
      if (qzRows.length) {
        quiz = qzRows[0];
        if (matricula) {
          const aprov = await Pg.connectAndQuery(`
            SELECT MAX(nota) AS melhor_nota,
                   COUNT(*) FILTER (WHERE finalizada_em IS NOT NULL) AS tentativas_feitas,
                   COUNT(*) FILTER (WHERE aprovado = true) > 0 AS aprovado
              FROM tab_uni_tentativa WHERE matricula_id = @mid AND quiz_id = @qid`,
            { mid: matricula.id, qid: quiz.id }
          );
          quiz.melhorNota = aprov[0].melhor_nota != null ? Number(aprov[0].melhor_nota) : null;
          quiz.tentativasFeitas = Number(aprov[0].tentativas_feitas || 0);
          quiz.aprovado = !!aprov[0].aprovado;
        }
      }

      return res.json({
        curso: cursoRows[0],
        aulas: aulasComProgresso,
        matricula,
        totalAulas: aulas.length,
        aulasConcluidas: aulasConcluidas.length,
        quiz
      });
    } catch (err) {
      console.error('Erro universidade/curso:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

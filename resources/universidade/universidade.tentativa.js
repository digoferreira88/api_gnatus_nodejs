// Detalhe da tentativa apos finalizada — mostra correcao (qual foi minha resposta + qual era a correta).
// GET /universidade/tentativa/:id

module.exports = (app) => ({
  verb: 'get',
  route: '/tentativa/:id',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });

    const tid = Number(req.params.id);
    if (!Number.isInteger(tid) || tid <= 0) return res.status(400).json({ message: 'ID invalido.' });

    try {
      const t = await Pg.connectAndQuery(`
        SELECT t.*, m.user_id, m.curso_id, q.titulo AS quiz_titulo, q.nota_minima
          FROM tab_uni_tentativa t
          INNER JOIN tab_uni_matricula m ON m.id = t.matricula_id
          INNER JOIN tab_uni_quiz q      ON q.id = t.quiz_id
         WHERE t.id = @tid`, { tid });
      if (!t.length) return res.status(404).json({ message: 'Tentativa nao encontrada.' });
      const tent = t[0];
      if (Number(tent.user_id) !== Number(user.ID)) return res.status(403).json({ message: 'Tentativa de outro usuario.' });

      // Questoes + alternativas (TODAS, com flag correta) + minha resposta
      const questoes = await Pg.connectAndQuery(`
        SELECT id, ordem, enunciado, tipo, pontuacao
          FROM tab_uni_questao WHERE quiz_id = @qid ORDER BY ordem, id`,
        { qid: tent.quiz_id }
      );
      const alternativas = questoes.length ? await Pg.connectAndQuery(`
        SELECT id, questao_id, ordem, texto, correta
          FROM tab_uni_alternativa
         WHERE questao_id IN (${questoes.map((_, i) => `@q${i}`).join(',')})
         ORDER BY questao_id, ordem, id`,
        questoes.reduce((acc, q, i) => { acc[`q${i}`] = q.id; return acc; }, {})
      ) : [];
      const respostas = await Pg.connectAndQuery(`
        SELECT questao_id, alternativa_id, correta, pontos
          FROM tab_uni_resposta WHERE tentativa_id = @tid`, { tid }
      );

      const altsPorQ = new Map();
      alternativas.forEach(a => {
        if (!altsPorQ.has(a.questao_id)) altsPorQ.set(a.questao_id, []);
        altsPorQ.get(a.questao_id).push(a);
      });
      const respPorQ = new Map(respostas.map(r => [r.questao_id, r]));

      const questoesRev = questoes.map(q => {
        const alts = altsPorQ.get(q.id) || [];
        const r = respPorQ.get(q.id);
        return {
          ...q,
          alternativas: alts,
          minhaRespostaId: r?.alternativa_id || null,
          minhaCorreta: r?.correta || false,
          meusPontos: Number(r?.pontos || 0)
        };
      });

      return res.json({
        tentativa: tent,
        questoes: questoesRev
      });
    } catch (err) {
      console.error('Erro universidade/tentativa:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

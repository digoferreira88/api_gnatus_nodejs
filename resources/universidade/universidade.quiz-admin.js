// Visao admin do quiz: traz tudo INCLUSIVE qual alternativa eh a correta.
// GET /universidade/quiz/:id/admin
// Permissao: dono do curso ou admin geral.

const { ehInstrutor, ehAdmin } = require('./_perms');

module.exports = (app) => ({
  verb: 'get',
  route: '/quiz/:id/admin',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });
    if (!(await ehInstrutor(Pg, user.ID))) return res.status(403).json({ message: 'Sem permissao.' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalido.' });

    try {
      const qz = await Pg.connectAndQuery(`
        SELECT q.*, c.instrutor_id, c.titulo AS curso_titulo
          FROM tab_uni_quiz q
          INNER JOIN tab_uni_curso c ON c.id = q.curso_id
         WHERE q.id = @id`, { id }
      );
      if (!qz.length) return res.status(404).json({ message: 'Quiz nao encontrado.' });
      if (Number(qz[0].instrutor_id) !== Number(user.ID) && !(await ehAdmin(Pg, user.ID))) {
        return res.status(403).json({ message: 'Voce nao pode editar.' });
      }

      const questoes = await Pg.connectAndQuery(`
        SELECT id, ordem, enunciado, tipo, pontuacao
          FROM tab_uni_questao WHERE quiz_id = @qid ORDER BY ordem, id`, { qid: id }
      );
      const alternativas = questoes.length ? await Pg.connectAndQuery(`
        SELECT id, questao_id, ordem, texto, correta
          FROM tab_uni_alternativa
         WHERE questao_id IN (${questoes.map((_, i) => `@q${i}`).join(',')})
         ORDER BY questao_id, ordem, id`,
        questoes.reduce((acc, q, i) => { acc[`q${i}`] = q.id; return acc; }, {})
      ) : [];

      const altsPorQ = new Map();
      alternativas.forEach(a => {
        if (!altsPorQ.has(a.questao_id)) altsPorQ.set(a.questao_id, []);
        altsPorQ.get(a.questao_id).push(a);
      });
      const questoesComAlts = questoes.map(q => ({ ...q, alternativas: altsPorQ.get(q.id) || [] }));

      return res.json({ quiz: qz[0], questoes: questoesComAlts });
    } catch (err) {
      console.error('Erro universidade/quiz/admin:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

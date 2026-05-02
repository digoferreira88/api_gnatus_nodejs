// Remove uma questao (CASCADE remove alternativas + respostas).
// DELETE /universidade/questao/:id

const { ehInstrutor, ehAdmin } = require('./_perms');

module.exports = (app) => ({
  verb: 'delete',
  route: '/questao/:id',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });
    if (!(await ehInstrutor(Pg, user.ID))) return res.status(403).json({ message: 'Sem permissao.' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalido.' });

    const q = await Pg.connectAndQuery(`
      SELECT c.instrutor_id FROM tab_uni_questao qq
      INNER JOIN tab_uni_quiz qz ON qz.id = qq.quiz_id
      INNER JOIN tab_uni_curso c ON c.id = qz.curso_id WHERE qq.id = @id`, { id });
    if (!q.length) return res.status(404).json({ message: 'Questao nao encontrada.' });
    if (Number(q[0].instrutor_id) !== Number(user.ID) && !(await ehAdmin(Pg, user.ID))) {
      return res.status(403).json({ message: 'Voce nao pode editar.' });
    }

    try {
      await Pg.connectAndQuery(`DELETE FROM tab_uni_questao WHERE id = @id`, { id });
      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro universidade/questao DELETE:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// Edita config do quiz. PATCH /universidade/quiz/:id

const trim = (v) => v == null ? null : String(v).trim();
const { ehInstrutor, ehAdmin } = require('./_perms');

module.exports = (app) => ({
  verb: 'patch',
  route: '/quiz/:id',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });
    if (!(await ehInstrutor(Pg, user.ID))) return res.status(403).json({ message: 'Sem permissao.' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalido.' });

    const q = await Pg.connectAndQuery(`
      SELECT q.id, c.instrutor_id FROM tab_uni_quiz q
      INNER JOIN tab_uni_curso c ON c.id = q.curso_id WHERE q.id = @id`, { id });
    if (!q.length) return res.status(404).json({ message: 'Quiz nao encontrado.' });
    if (Number(q[0].instrutor_id) !== Number(user.ID) && !(await ehAdmin(Pg, user.ID))) {
      return res.status(403).json({ message: 'Voce nao pode editar.' });
    }

    const sets = [];
    const params = { id };
    const map = {
      titulo: 'titulo', descricao: 'descricao', notaMinima: 'nota_minima',
      tentativasMax: 'tentativas_max', embaralhar: 'embaralhar', ativo: 'ativo'
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in req.body) {
        sets.push(`${col} = @${k}`);
        const v = req.body[k];
        if (k === 'notaMinima') params[k] = Number(v);
        else if (k === 'tentativasMax') params[k] = Number(v);
        else if (k === 'embaralhar' || k === 'ativo') params[k] = !!v;
        else params[k] = trim(v);
      }
    }
    if (!sets.length) return res.status(400).json({ message: 'Nada a atualizar.' });
    sets.push('atualizado_em = NOW()');

    try {
      await Pg.connectAndQuery(`UPDATE tab_uni_quiz SET ${sets.join(', ')} WHERE id = @id`, params);
      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro universidade/quiz PATCH:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

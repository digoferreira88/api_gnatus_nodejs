// Cria quiz pra um curso. So pode haver 1 quiz por curso.
// POST /universidade/curso/:cursoId/quiz
// Body: { titulo, descricao?, notaMinima?, tentativasMax?, embaralhar? }

const trim = (v) => v == null ? null : String(v).trim();
const { ehInstrutor, ehAdmin } = require('./_perms');

module.exports = (app) => ({
  verb: 'post',
  route: '/curso/:cursoId/quiz',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });
    if (!(await ehInstrutor(Pg, user.ID))) return res.status(403).json({ message: 'Sem permissao.' });

    const cursoId = Number(req.params.cursoId);
    if (!Number.isInteger(cursoId) || cursoId <= 0) return res.status(400).json({ message: 'cursoId invalido.' });

    const c = await Pg.connectAndQuery(`SELECT instrutor_id FROM tab_uni_curso WHERE id = @id`, { id: cursoId });
    if (!c.length) return res.status(404).json({ message: 'Curso nao encontrado.' });
    if (Number(c[0].instrutor_id) !== Number(user.ID) && !(await ehAdmin(Pg, user.ID))) {
      return res.status(403).json({ message: 'Voce nao pode editar este curso.' });
    }

    const titulo = trim(req.body?.titulo);
    if (!titulo) return res.status(400).json({ message: 'titulo obrigatorio.' });

    try {
      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_uni_quiz (curso_id, titulo, descricao, nota_minima, tentativas_max, embaralhar)
        VALUES (@cid, @tit, @desc, @nm, @tm, @emb)
        RETURNING id`,
        {
          cid: cursoId, tit: titulo,
          desc: trim(req.body?.descricao),
          nm: req.body?.notaMinima != null ? Number(req.body.notaMinima) : 70,
          tm: req.body?.tentativasMax != null ? Number(req.body.tentativasMax) : 3,
          emb: !!req.body?.embaralhar
        }
      );
      return res.json({ ok: true, id: ins[0].id });
    } catch (err) {
      if (String(err.message).includes('duplicate')) {
        return res.status(409).json({ message: 'Curso ja tem quiz.' });
      }
      console.error('Erro universidade/quiz POST:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// Cria questao + alternativas em 1 chamada (mais ergonomico).
// POST /universidade/quiz/:quizId/questao
// Body: {
//   enunciado, tipo? (multipla_escolha|verdadeiro_falso), pontuacao?, ordem?,
//   alternativas: [{ texto, correta }]   -- pra v/f passar 2 alternativas (V e F)
// }

const trim = (v) => v == null ? null : String(v).trim();
const { ehInstrutor, ehAdmin } = require('./_perms');
const TIPOS = ['multipla_escolha', 'verdadeiro_falso'];

module.exports = (app) => ({
  verb: 'post',
  route: '/quiz/:quizId/questao',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });
    if (!(await ehInstrutor(Pg, user.ID))) return res.status(403).json({ message: 'Sem permissao.' });

    const quizId = Number(req.params.quizId);
    if (!Number.isInteger(quizId) || quizId <= 0) return res.status(400).json({ message: 'quizId invalido.' });

    const q = await Pg.connectAndQuery(`
      SELECT c.instrutor_id FROM tab_uni_quiz qz
      INNER JOIN tab_uni_curso c ON c.id = qz.curso_id WHERE qz.id = @id`, { id: quizId });
    if (!q.length) return res.status(404).json({ message: 'Quiz nao encontrado.' });
    if (Number(q[0].instrutor_id) !== Number(user.ID) && !(await ehAdmin(Pg, user.ID))) {
      return res.status(403).json({ message: 'Voce nao pode editar.' });
    }

    const enunciado = trim(req.body?.enunciado);
    if (!enunciado) return res.status(400).json({ message: 'enunciado obrigatorio.' });
    const tipo = TIPOS.includes(req.body?.tipo) ? req.body.tipo : 'multipla_escolha';
    const alts = Array.isArray(req.body?.alternativas) ? req.body.alternativas : [];

    if (alts.length < 2) return res.status(400).json({ message: 'Pelo menos 2 alternativas.' });
    if (alts.filter(a => a.correta).length !== 1) return res.status(400).json({ message: 'Exatamente 1 alternativa correta.' });

    let ordem = req.body?.ordem != null ? Number(req.body.ordem) : null;
    if (ordem == null) {
      const max = await Pg.connectAndQuery(
        `SELECT COALESCE(MAX(ordem), 0) m FROM tab_uni_questao WHERE quiz_id = @id`, { id: quizId }
      );
      ordem = Number(max[0].m || 0) + 1;
    }

    try {
      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_uni_questao (quiz_id, ordem, enunciado, tipo, pontuacao)
        VALUES (@qid, @ord, @enu, @tipo, @pts) RETURNING id`,
        {
          qid: quizId, ord: ordem, enu: enunciado, tipo,
          pts: req.body?.pontuacao != null ? Number(req.body.pontuacao) : 1
        }
      );
      const questaoId = ins[0].id;

      for (let i = 0; i < alts.length; i++) {
        await Pg.connectAndQuery(
          `INSERT INTO tab_uni_alternativa (questao_id, ordem, texto, correta)
           VALUES (@qid, @ord, @tx, @cor)`,
          { qid: questaoId, ord: i + 1, tx: trim(alts[i].texto), cor: !!alts[i].correta }
        );
      }
      return res.json({ ok: true, id: questaoId });
    } catch (err) {
      console.error('Erro universidade/questao POST:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

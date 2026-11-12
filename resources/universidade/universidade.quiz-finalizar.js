// Finaliza uma tentativa: recebe respostas, corrige, calcula nota e atualiza
// progresso da matricula (pode marcar curso como concluido se todas aulas
// obrigatorias OK + nota >= nota_minima).
//
// POST /universidade/tentativa/:id/finalizar
// Body: { respostas: [{ questaoId, alternativaId }] }

const Quiz = require('./_quiz');

module.exports = (app) => ({
  verb: 'post',
  route: '/tentativa/:id/finalizar',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });

    const tid = Number(req.params.id);
    if (!Number.isInteger(tid) || tid <= 0) return res.status(400).json({ message: 'ID invalido.' });

    const respostas = Array.isArray(req.body?.respostas) ? req.body.respostas : null;
    if (!respostas) return res.status(400).json({ message: 'Forneca respostas:[].' });

    try {
      // Valida tentativa: pertence ao user e nao foi finalizada
      const t = await Pg.connectAndQuery(`
        SELECT t.id, t.matricula_id, t.quiz_id, t.finalizada_em, t.nota, t.aprovado, t.questoes AS sorteio,
               m.user_id, m.curso_id, q.nota_minima
          FROM tab_uni_tentativa t
          INNER JOIN tab_uni_matricula m ON m.id = t.matricula_id
          INNER JOIN tab_uni_quiz q      ON q.id = t.quiz_id
         WHERE t.id = @tid`, { tid });
      if (!t.length) return res.status(404).json({ message: 'Tentativa nao encontrada.' });
      const tent = t[0];
      if (Number(tent.user_id) !== Number(user.ID)) return res.status(403).json({ message: 'Tentativa de outro usuario.' });

      // Se ja foi finalizada (double-submit, refresh, outra aba), retorna o resultado existente
      // em vez de 409. Idempotente — UX melhor que erro tecnico.
      if (tent.finalizada_em) {
        const cnt = await Pg.connectAndQuery(`
          SELECT
            COUNT(*) FILTER (WHERE correta = true) AS corretas,
            COUNT(*) AS total,
            SUM(pontos) AS obtidos,
            (SELECT COALESCE(SUM(qq.pontuacao), 0) FROM tab_uni_questao qq
              WHERE qq.quiz_id = @qid AND (@todas OR qq.id IN (SELECT questao_id FROM tab_uni_resposta WHERE tentativa_id = @tid))) AS maximo
          FROM tab_uni_resposta WHERE tentativa_id = @tid`,
          { tid, qid: tent.quiz_id, todas: !Array.isArray(tent.sorteio) || !tent.sorteio.length }
        );
        const c = cnt[0] || {};
        return res.json({
          ok: true,
          jaFinalizadaAntes: true,
          nota: Number(tent.nota || 0),
          aprovado: !!tent.aprovado,
          notaMinima: Number(tent.nota_minima || 0),
          pontosObtidos: Number(c.obtidos || 0),
          pontosTotal: Number(c.maximo || 0),
          questoesCorretas: Number(c.corretas || 0),
          questoesTotal: Number(c.total || 0)
        });
      }

      // Questões que ESTA tentativa recebeu (sorteio) com a alternativa correta + pontuação.
      const questoes = Quiz.montar(await Quiz.banco(Pg, tent.quiz_id), tent.sorteio, true).map(q => ({
        id: q.id, pontuacao: q.pontuacao, alt_correta: (q.alternativas.find(a => a.correta) || {}).id || null
      }));

      const respostasMap = new Map();
      respostas.forEach(r => respostasMap.set(Number(r.questaoId), r.alternativaId != null ? Number(r.alternativaId) : null));

      let pontosTotal = 0, pontosObtidos = 0;
      for (const q of questoes) {
        const respAlt = respostasMap.has(q.id) ? respostasMap.get(q.id) : null;
        const correta = respAlt != null && Number(q.alt_correta) === respAlt;
        const pontos = correta ? Number(q.pontuacao) : 0;
        pontosTotal += Number(q.pontuacao);
        pontosObtidos += pontos;

        await Pg.connectAndQuery(`
          INSERT INTO tab_uni_resposta (tentativa_id, questao_id, alternativa_id, correta, pontos)
          VALUES (@tid, @qid, @aid, @cor, @pts)
          ON CONFLICT (tentativa_id, questao_id) DO UPDATE
            SET alternativa_id = EXCLUDED.alternativa_id,
                correta = EXCLUDED.correta,
                pontos = EXCLUDED.pontos`,
          { tid, qid: q.id, aid: respAlt, cor: correta, pts: pontos }
        );
      }

      const nota = pontosTotal > 0 ? (pontosObtidos / pontosTotal) * 100 : 0;
      const aprovado = nota >= Number(tent.nota_minima);

      await Pg.connectAndQuery(`
        UPDATE tab_uni_tentativa SET finalizada_em = NOW(), nota = @nota, aprovado = @apr
         WHERE id = @tid`,
        { tid, nota: Number(nota.toFixed(2)), apr: aprovado }
      );

      // Recalcula progresso do curso (aulas + quiz). Se nenhuma aula obrigatoria,
      // conta todas (fallback robusto).
      const totObrig = await Pg.connectAndQuery(
        `SELECT COUNT(*)::int total FROM tab_uni_aula WHERE curso_id = @cid AND obrigatoria = true`,
        { cid: tent.curso_id }
      );
      const totConcObrig = await Pg.connectAndQuery(
        `SELECT COUNT(*)::int total
           FROM tab_uni_progresso p INNER JOIN tab_uni_aula a ON a.id = p.aula_id
          WHERE p.matricula_id = @mid AND a.obrigatoria = true`,
        { mid: tent.matricula_id }
      );

      let total = Number(totObrig[0].total || 0);
      let conc = Number(totConcObrig[0].total || 0);
      if (total === 0) {
        const tAll = await Pg.connectAndQuery(
          `SELECT COUNT(*)::int total FROM tab_uni_aula WHERE curso_id = @cid`, { cid: tent.curso_id }
        );
        const tcAll = await Pg.connectAndQuery(
          `SELECT COUNT(*)::int total FROM tab_uni_progresso p
             INNER JOIN tab_uni_aula a ON a.id = p.aula_id
            WHERE p.matricula_id = @mid`, { mid: tent.matricula_id }
        );
        total = Number(tAll[0].total || 0);
        conc  = Number(tcAll[0].total || 0);
      }
      // Curso sem aula (ex.: presencial com avaliação): conclui só pela avaliação.
      const aulasOk = total === 0 || conc >= total;
      // Se ja existiu aprovacao previa, mantem aprovado
      const jaAprovouAntes = await Pg.connectAndQuery(`
        SELECT 1 FROM tab_uni_tentativa
         WHERE matricula_id = @mid AND quiz_id = @qid AND aprovado = true LIMIT 1`,
        { mid: tent.matricula_id, qid: tent.quiz_id }
      );
      const quizOk = aprovado || jaAprovouAntes.length > 0;

      // Progresso considera aulas + (quiz se existir)
      // Se aulas 100% e quiz aprovado -> concluido
      const concluiuTudo = aulasOk && quizOk;
      // % progresso simples: media entre aulas e quiz (50/50 quando ha quiz; 100% aulas se nao ha quiz - mas aqui sempre ha pq estamos no fluxo do quiz)
      const pctAulas = total > 0 ? (conc / total) * 100 : 100;
      const pctQuiz = quizOk ? 100 : 0;
      const pct = (pctAulas + pctQuiz) / 2;

      await Pg.connectAndQuery(`
        UPDATE tab_uni_matricula
           SET percent_progresso = @pct::numeric,
               status = CASE WHEN @conc::boolean THEN 'concluido' WHEN @pct::numeric > 0 THEN 'em_andamento' ELSE 'matriculado' END,
               data_conclusao = CASE WHEN @conc::boolean AND data_conclusao IS NULL THEN NOW() ELSE data_conclusao END
         WHERE id = @mid`,
        { pct: Number(pct.toFixed(2)), conc: concluiuTudo, mid: tent.matricula_id }
      );

      return res.json({
        ok: true,
        nota: Number(nota.toFixed(2)),
        aprovado,
        notaMinima: Number(tent.nota_minima),
        pontosObtidos: Number(pontosObtidos.toFixed(2)),
        pontosTotal: Number(pontosTotal.toFixed(2)),
        questoesCorretas: questoes.filter(q => respostasMap.get(q.id) === Number(q.alt_correta)).length,
        questoesTotal: questoes.length,
        cursoConcluido: concluiuTudo
      });
    } catch (err) {
      console.error('Erro universidade/quiz/finalizar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

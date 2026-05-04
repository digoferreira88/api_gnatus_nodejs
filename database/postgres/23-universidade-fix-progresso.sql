-- Fix retroativo: aulas existentes criadas com obrigatoria=false (default antigo
-- do admin) ficavam fora do calculo de progresso. Marca todas como obrigatorias
-- e recalcula percent_progresso de cada matricula com base nas aulas concluidas.
--
-- Idempotente: pode rodar varias vezes.

-- 1) Marca todas as aulas existentes como obrigatorias (default novo)
UPDATE tab_uni_aula SET obrigatoria = true WHERE obrigatoria = false;

-- 2) Recalcula percent_progresso de cada matricula
WITH stats AS (
    SELECT m.id AS matricula_id,
           (SELECT COUNT(*) FROM tab_uni_aula a WHERE a.curso_id = m.curso_id) AS total,
           (SELECT COUNT(*) FROM tab_uni_progresso p
              INNER JOIN tab_uni_aula a ON a.id = p.aula_id
             WHERE p.matricula_id = m.id) AS conc,
           (SELECT id FROM tab_uni_quiz q WHERE q.curso_id = m.curso_id AND q.ativo = true LIMIT 1) AS quiz_id
      FROM tab_uni_matricula m
), progresso_calc AS (
    SELECT s.matricula_id,
           CASE WHEN s.quiz_id IS NULL THEN
               CASE WHEN s.total > 0 THEN (s.conc::numeric / s.total) * 100 ELSE 0 END
           ELSE
               -- Com quiz: media (aulas + quiz_aprovado)
               (CASE WHEN s.total > 0 THEN (s.conc::numeric / s.total) * 100 ELSE 0 END
                + CASE WHEN EXISTS (
                    SELECT 1 FROM tab_uni_tentativa t
                     WHERE t.matricula_id = s.matricula_id AND t.quiz_id = s.quiz_id AND t.aprovado = true
                  ) THEN 100 ELSE 0 END
               ) / 2
           END AS pct,
           (s.total > 0 AND s.conc >= s.total
            AND (s.quiz_id IS NULL
                 OR EXISTS (SELECT 1 FROM tab_uni_tentativa t
                             WHERE t.matricula_id = s.matricula_id
                               AND t.quiz_id = s.quiz_id AND t.aprovado = true))) AS concluiu
      FROM stats s
)
UPDATE tab_uni_matricula m
   SET percent_progresso = ROUND(pc.pct::numeric, 2),
       status = CASE WHEN pc.concluiu THEN 'concluido'
                     WHEN pc.pct > 0 THEN 'em_andamento'
                     ELSE 'matriculado' END,
       data_conclusao = CASE WHEN pc.concluiu AND m.data_conclusao IS NULL THEN NOW()
                              ELSE m.data_conclusao END
  FROM progresso_calc pc
 WHERE m.id = pc.matricula_id;

-- NPS/CSAT — a pesquisa da equipe de CX classifica pela OPÇÃO escolhida (não por
-- nota 0-10). Adiciona:
--   - tab_nps_pergunta.class_map (jsonb): opção -> PROMOTOR|NEUTRO|DETRATOR
--   - tab_nps_acao.causa: causa classificada pelo time no detrator (regra CX)
-- e substitui as perguntas default pelas do formulário CSAT enviado. Idempotente.

ALTER TABLE tab_nps_pergunta ADD COLUMN IF NOT EXISTS class_map JSONB;
ALTER TABLE tab_nps_acao ADD COLUMN IF NOT EXISTS causa VARCHAR(160);

-- Perguntas do CX (só insere se ainda não existir a pergunta de satisfação).
-- Desativa as perguntas default de NPS 0-10 e insere o conjunto CSAT.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tab_nps_pergunta WHERE texto ILIKE 'Como você avalia sua experiência de compra%') THEN
    UPDATE tab_nps_pergunta SET ativa = FALSE, e_nps = FALSE;
    INSERT INTO tab_nps_pergunta (ordem, texto, tipo, opcoes, class_map, obrigatoria, e_nps, ativa) VALUES
      (1, 'Como você avalia sua experiência de compra com a Gnatus?', 'opcao',
       '["Muito satisfeito","Satisfeito","Neutro","Insatisfeito","Muito insatisfeito"]'::jsonb,
       '{"Muito satisfeito":"PROMOTOR","Satisfeito":"PROMOTOR","Neutro":"NEUTRO","Insatisfeito":"DETRATOR","Muito insatisfeito":"DETRATOR"}'::jsonb,
       TRUE, TRUE, TRUE),
      (2, 'O que mais gostou no atendimento?', 'texto', NULL, NULL, FALSE, FALSE, TRUE),
      (3, 'Existe algo que poderíamos melhorar?', 'texto', NULL, NULL, FALSE, FALSE, TRUE);
  END IF;
END $$;

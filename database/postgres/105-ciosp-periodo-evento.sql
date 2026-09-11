-- 105 — CIOSP: período do evento (habilita ritmo e projeção no painel)
--
-- O painel precisa responder "estamos no ritmo?" e "qual a projeção de
-- fechamento?". Essas duas respostas exigem saber quantos dias o evento tem e
-- quantos já passaram — informação que NÃO existia em lugar nenhum: a venda tem
-- data_venda, mas nada dizia quando o evento começa e termina.
--
-- Sem isso, qualquer projeção seria chute. Com as duas datas abaixo, ritmo e
-- projeção passam a ser calculados a partir de dado real.
--
-- Ambas NULL por padrão: enquanto não forem preenchidas, o painel mostra os
-- componentes de ritmo/projeção em estado "não configurado" (nunca um número
-- inventado). Nada do que já existe muda de comportamento.

ALTER TABLE tab_ciosp_meta ADD COLUMN IF NOT EXISTS data_inicio DATE;
ALTER TABLE tab_ciosp_meta ADD COLUMN IF NOT EXISTS data_fim    DATE;

COMMENT ON COLUMN tab_ciosp_meta.data_inicio IS 'Primeiro dia do evento — base p/ ritmo e projeção no painel';
COMMENT ON COLUMN tab_ciosp_meta.data_fim    IS 'Último dia do evento — base p/ ritmo e projeção no painel';

-- 116 — Economia de chamadas na API do Pipefy (18/09/2026)
--
-- Contexto: o contrato dá 10.000 chamadas/mês e setembro fechou em ~25.800. A medição
-- apontou o robô do RHP (varria 901 cards em 12 fases, 28x/dia = ~16.600/mês), a trava
-- do SAC no NPS (~2.600) e a consulta do telefone do responsável a cada webhook (~1.400).
--
-- Esta migration cria só o apoio das correções:
--   tab_pipefy_usuario_whats  cache do telefone do responsável (evita 1 consulta por evento)
--   tab_pipefy_uso            contador de chamadas por rotina e por dia, para acompanhar
--                             o consumo sem depender da fatura

CREATE TABLE IF NOT EXISTS tab_pipefy_usuario_whats (
  id_usuario    TEXT PRIMARY KEY,           -- id do usuário no Pipefy (title da tabela 306929792)
  whatsapp      TEXT NOT NULL DEFAULT '',   -- só dígitos; vazio = usuário sem telefone cadastrado
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tab_pipefy_usuario_whats IS
  'Cache do WhatsApp do responsável (Pipefy). Validade em PIPEFY_WHATS_CACHE_DIAS (padrão 7). Trocou o telefone no Pipefy e precisa valer agora? Apague a linha do usuário.';

CREATE TABLE IF NOT EXISTS tab_pipefy_uso (
  dia       DATE NOT NULL,
  rotina    TEXT NOT NULL,                  -- rhp-recon | nps-sac | webhook | op | garantia | painel
  chamadas  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dia, rotina)
);

COMMENT ON TABLE tab_pipefy_uso IS
  'Requisições HTTP à API do Pipefy por rotina e por dia. Alimentado em memória e gravado a cada 10 min pelo scheduler (job pipefy-uso).';

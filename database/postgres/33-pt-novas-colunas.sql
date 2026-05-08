-- Poder de Terceiros: planilha do fiscal ganhou 2 colunas novas no inicio:
--   ATUALIZADO EM:    (data) - quando o fiscal validou pela ultima vez
--   NOVO VENCIMENTO   (texto livre) - "SEM ATUALIZACAO", "EM PROCESSO DE
--                                     RETORNO", "RETORNOU", "BAIXADO", etc

ALTER TABLE tab_pt_envio
  ADD COLUMN IF NOT EXISTS atualizado_em_planilha date,
  ADD COLUMN IF NOT EXISTS novo_vencimento_obs    varchar(200);

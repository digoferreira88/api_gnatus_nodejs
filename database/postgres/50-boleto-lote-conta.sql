-- 50-boleto-lote-conta.sql
-- Envio de Boleto: registra a AGENCIA e a CONTA do portador escolhido no lote.
--
-- Ate aqui o lote guardava so banco_cod (ex: 341 Itau) e banco_nome (rotulo).
-- Como um banco pode ter varias contas de cobranca (ex: Itau ag 0298 com cc
-- 12541, 25776, 789009...), o bordero precisa saber a conta especifica — senao
-- sai sem agencia/conta (E1_AGEDEP/E1_CONTA vazios). Estas colunas guardam a
-- conta escolhida pra enviar ao Protheus em POST /Cobranca/gerar-bordero.

ALTER TABLE tab_boleto_envio_lote
    ADD COLUMN IF NOT EXISTS banco_agencia varchar(15),
    ADD COLUMN IF NOT EXISTS banco_conta   varchar(20);

COMMENT ON COLUMN tab_boleto_envio_lote.banco_agencia IS
    'Agencia do portador escolhido (A6_AGENCIA). Enviada ao Protheus pra o bordero ir na conta certa.';
COMMENT ON COLUMN tab_boleto_envio_lote.banco_conta IS
    'Conta corrente do portador escolhido (A6_NUMCON, sem DV). Enviada ao Protheus pra o bordero ir na conta certa.';

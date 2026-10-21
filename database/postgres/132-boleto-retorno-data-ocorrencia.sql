-- 132-boleto-retorno-data-ocorrencia.sql — 21/10/2026
-- Envio de Boleto: data da ocorrencia do arquivo de retorno (.RET) na linha de
-- retorno do titulo.
--
-- O boleto do Grupo BFC (portador 699, cessao) traz "Data do documento" e "Data
-- processamento" = a data da ENTRADA CONFIRMADA no retorno do fundo (30/09 no
-- modelo docs/financeiro/boleto bfc.pdf), nao a emissao do titulo. Para o PDF
-- da intranet sair igual ao do fundo, o "Registrar pelo .RET" grava essa data.
--
-- ⚠️ APLICAR ANTES de recarregar a API: o boleto-pdf e o boleto-disparar leem
-- esta coluna (para todos os bancos).

ALTER TABLE tab_boleto_envio_lote_retorno
    ADD COLUMN IF NOT EXISTS data_ocorrencia varchar(8);

COMMENT ON COLUMN tab_boleto_envio_lote_retorno.data_ocorrencia IS
    'Data da ocorrencia no arquivo de retorno (.RET), YYYYMMDD. Gravada pelo "Registrar pelo .RET". No BFC vira a data do documento/processamento do boleto.';

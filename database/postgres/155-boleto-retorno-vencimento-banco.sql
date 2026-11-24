-- 155-boleto-retorno-vencimento-banco.sql — 24/11/2026
-- Envio de Boleto: vencimento REGISTRADO NO BANCO, lido do arquivo de retorno
-- (.RET), na linha de retorno do titulo.
--
-- Por que: a linha digitavel e o codigo de barras precisam do vencimento que o
-- banco registrou. Santander/Itau registram pelo E1_VENCTO, e a intranet usa
-- ele. Os fundos nao seguem uma regra so:
--   - Acreditar (044, borderô 418826, retornos de 29/10 e 03/11/2026) registrou
--     pelo E1_VENCREA nos 113 titulos; em 45 deles o E1_VENCTO e' outro dia (fim
--     de semana) e o boleto sairia com fator de vencimento errado;
--   - Grupo BFC (699) registrou pelo E1_VENCTO.
-- So o .RET sabe. O "Registrar pelo .RET" grava esta coluna nos portadores de
-- cessao, e o PDF/disparo usam ela antes do E1_VENCTO.
--
-- ⚠️ APLICAR ANTES de recarregar a API: o boleto-adotar-retorno, o boleto-pdf
-- e o boleto-disparar leem esta coluna (para todos os bancos).

ALTER TABLE tab_boleto_envio_lote_retorno
    ADD COLUMN IF NOT EXISTS vencimento_banco varchar(8);

COMMENT ON COLUMN tab_boleto_envio_lote_retorno.vencimento_banco IS
    'Vencimento registrado no banco, lido do .RET (YYYYMMDD). Gravado pelo "Registrar pelo .RET" nos portadores de cessao. Quando preenchido, a linha digitavel e o PDF usam ele no lugar do E1_VENCTO.';

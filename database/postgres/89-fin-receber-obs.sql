-- Contas a Receber: observações por título (14/08/2026). Idempotente.
--
-- O Protheus é read-only pra nós (salvo exceções documentadas), então a anotação
-- da equipe financeira sobre um título (ex.: "cliente vai pagar dia 20",
-- "negociado desconto") vive aqui, chaveada pela chave natural da SE1:
-- filial + prefixo + numero + parcela + tipo.
CREATE TABLE IF NOT EXISTS tab_fin_receber_obs (
  id             SERIAL PRIMARY KEY,
  filial         VARCHAR(4)  NOT NULL DEFAULT '',
  prefixo        VARCHAR(6)  NOT NULL DEFAULT '',
  numero         VARCHAR(12) NOT NULL,
  parcela        VARCHAR(4)  NOT NULL DEFAULT '',
  tipo           VARCHAR(6)  NOT NULL DEFAULT '',
  obs            TEXT NOT NULL,
  atualizado_por VARCHAR(120),
  atualizado_em  TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_fin_receber_obs UNIQUE (filial, prefixo, numero, parcela, tipo)
);
CREATE INDEX IF NOT EXISTS ix_fin_receber_obs_num ON tab_fin_receber_obs (numero);

-- Controle de Acesso (Intelbras): cadastro das TAGs por posição (14/08/2026).
-- Idempotente.
--
-- O dispositivo Intelbras tem 1000 posições de usuário; a planilha da TI amarra
-- posição -> colaborador + setor + nº da tag. Este cadastro traz esse controle
-- pra intranet (fonte da verdade passa a ser aqui; o aparelho é programado à mão
-- a partir desta tela). A posição é a chave (1..1000).

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (1034, 'Tecnologia - Tags de Acesso (Intelbras)', 'Tecnologia')
ON CONFLICT (id_permissao) DO NOTHING;

CREATE TABLE IF NOT EXISTS tab_acesso_tag (
  posicao        INTEGER PRIMARY KEY CHECK (posicao BETWEEN 1 AND 1000),
  colaborador    VARCHAR(120) NOT NULL,
  setor          VARCHAR(80)  NOT NULL DEFAULT '',
  tag            VARCHAR(40)  NOT NULL DEFAULT '',
  obs            VARCHAR(300),
  atualizado_por VARCHAR(120),
  atualizado_em  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_acesso_tag_tag ON tab_acesso_tag (tag);
CREATE INDEX IF NOT EXISTS ix_acesso_tag_colab ON tab_acesso_tag (LOWER(colaborador));

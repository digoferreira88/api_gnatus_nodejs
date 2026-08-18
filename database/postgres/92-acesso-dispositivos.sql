-- Tags de Acesso: MÚLTIPLOS controladores Intelbras (18/08/2026). Idempotente.
--
-- O cadastro nasceu com um único aparelho (o da Produção, migration 90). A
-- empresa tem vários controladores, cada um com suas 1000 posições próprias e
-- independentes. Este migration cria o cadastro de dispositivos e move a chave
-- da tag pra (dispositivo, posição).
--
-- ⚠️ A MESMA tag física pode (e deve) existir em controladores diferentes — o
-- crachá de uma pessoa abre várias portas. A unicidade da tag é POR dispositivo,
-- nunca global. (O código de importar/salvar já valida nesse escopo.)

CREATE TABLE IF NOT EXISTS tab_acesso_dispositivo (
  id         SERIAL PRIMARY KEY,
  nome       VARCHAR(60) NOT NULL UNIQUE,
  local      VARCHAR(120),
  capacidade INTEGER NOT NULL DEFAULT 1000,
  ordem      INTEGER NOT NULL DEFAULT 0,
  criado_em  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Aparelho original (os dados existentes da migration 90 pertencem a ele)
INSERT INTO tab_acesso_dispositivo (nome, local, ordem)
SELECT 'Produção', 'Setor de produção', 1
 WHERE NOT EXISTS (SELECT 1 FROM tab_acesso_dispositivo);

-- Vincula as posições existentes ao primeiro dispositivo
ALTER TABLE tab_acesso_tag ADD COLUMN IF NOT EXISTS dispositivo_id INTEGER;
UPDATE tab_acesso_tag
   SET dispositivo_id = (SELECT MIN(id) FROM tab_acesso_dispositivo)
 WHERE dispositivo_id IS NULL;
ALTER TABLE tab_acesso_tag ALTER COLUMN dispositivo_id SET NOT NULL;

-- FK + troca da PK: posicao -> (dispositivo_id, posicao)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_acesso_tag_dispositivo') THEN
    ALTER TABLE tab_acesso_tag
      ADD CONSTRAINT fk_acesso_tag_dispositivo
      FOREIGN KEY (dispositivo_id) REFERENCES tab_acesso_dispositivo(id);
  END IF;

  -- PK antiga era só (posicao). Se ainda for, troca pela composta.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'tab_acesso_tag'::regclass AND c.contype = 'p'
       AND array_length(c.conkey, 1) = 1
  ) THEN
    ALTER TABLE tab_acesso_tag DROP CONSTRAINT tab_acesso_tag_pkey;
    ALTER TABLE tab_acesso_tag ADD PRIMARY KEY (dispositivo_id, posicao);
  END IF;
END $$;

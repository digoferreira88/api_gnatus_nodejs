-- DRE por Centro de Custo: escopo por gestor + contas ocultas. Idempotente.
--
-- Contexto (12/08/2026): até aqui a perm 10001 era tudo-ou-nada — quem entrava no
-- DRE via TODOS os centros de custo. O gestor de CC precisa ver só o dele, e sem a
-- conta de honorários de serviços tomados (41100010020), que é informação sensível
-- de contrato e não é gasto que ele administre.
--
-- Desenho: permissão SEPARADA (10003). Quem tem 10001 (ou 0) segue com a visão
-- completa; quem tem SÓ a 10003 cai no modo restrito. Assim ninguém perde acesso
-- por engano e o gestor nunca é promovido à visão completa sem querer.

-- ===== 1) Permissão do gestor restrito =====
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (10003, 'Gerência - DRE do meu Centro de Custo', 'Gerência')
ON CONFLICT (id_permissao) DO NOTHING;

-- ===== 2) Vínculo usuário -> centro(s) de custo =====
-- Um gestor pode responder por mais de um CC (ex.: comercial atacado + varejo).
-- cc_codigo = CTT010.CTT_CUSTO (o mesmo código usado em C7_CC / CT2_CCD).
CREATE TABLE IF NOT EXISTS tab_dre_cc_usuario (
  id           SERIAL PRIMARY KEY,
  id_user      INTEGER NOT NULL REFERENCES tab_intranet_usr(id) ON DELETE CASCADE,
  cc_codigo    VARCHAR(20) NOT NULL,
  cc_descricao VARCHAR(120),
  criado_em    TIMESTAMP NOT NULL DEFAULT NOW(),
  criado_por   INTEGER,
  CONSTRAINT uq_dre_cc_usuario UNIQUE (id_user, cc_codigo)
);
CREATE INDEX IF NOT EXISTS ix_dre_cc_usuario_user ON tab_dre_cc_usuario (id_user);

-- ===== 3) Contas contábeis ocultas no modo restrito =====
-- Tabela (e não lista hardcoded) porque a controladoria vai querer incluir outras
-- contas sensíveis sem depender de deploy. Só afeta quem está no modo restrito —
-- a visão completa continua mostrando tudo.
CREATE TABLE IF NOT EXISTS tab_dre_conta_oculta (
  id         SERIAL PRIMARY KEY,
  conta      VARCHAR(30) NOT NULL UNIQUE,
  descricao  VARCHAR(160),
  motivo     VARCHAR(300),
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em  TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO tab_dre_conta_oculta (conta, descricao, motivo) VALUES
  ('41100010020', 'HONORÁRIOS DE SERVIÇOS TOMADOS',
   'Informação sensível de contrato; não é gasto administrado pelo gestor do centro de custo.')
ON CONFLICT (conta) DO NOTHING;

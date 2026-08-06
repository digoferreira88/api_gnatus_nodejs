-- Filtro "escondido" de status de cobrança para o dashboard de Carteira de Cobrança.
-- Config GLOBAL (uma só), gerida pela gestora (perm 9001). Guarda os status a
-- EXCLUIR quando a operadora liga o "checkbox cego" no dashboard. Singleton (id=1).
-- Os status válidos são os mesmos de resources/cobranca/cobranca.status.js
-- (services/cobrancaStatus.js é a fonte única compartilhada).

CREATE TABLE IF NOT EXISTS tab_cobranca_filtro_status (
  id               INTEGER     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  status_excluidos JSONB       NOT NULL DEFAULT '[]'::jsonb,
  atualizado_por   INTEGER,
  atualizado_em    TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO tab_cobranca_filtro_status (id, status_excluidos)
VALUES (1, '[]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Permissão dedicada à GESTORA (9005): configura os status flagados. A operadora
-- continua com 9001 (vê o dashboard + o checkbox cego), mas NÃO acessa esta config.
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (9005, 'Cobrança - Filtro escondido (config)', 'Cobrança')
ON CONFLICT (id_permissao) DO UPDATE
   SET nome = EXCLUDED.nome, modulo = EXCLUDED.modulo;

-- Concede ao admin (os demais são atribuídos na Gestão de Usuários).
INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao, matricula)
SELECT u.id, 9005, u.matricula FROM tab_intranet_usr u WHERE u.email = 'admin@gnatus.com.br'
ON CONFLICT (id_user, id_permissao) DO NOTHING;

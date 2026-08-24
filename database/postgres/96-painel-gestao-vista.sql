-- Painel de Gestão à Vista (Pipefy) — permissão (19/08/2026). Idempotente.
-- Painel de TV para pontos da empresa: todos os cards abertos de todos os pipes
-- da org no Pipefy (atrasados, responsáveis, gargalos). Sem tabela própria: o
-- snapshot vive em memória no backend (cache ~5 min). As TVs usam um usuário
-- dedicado com SÓ esta permissão (mesmo padrão do Painel OP da Produção).

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (10004, 'Gerência - Painel de Gestão à Vista (TV)', 'Gerência')
ON CONFLICT (id_permissao) DO NOTHING;

-- Painel de Gestão à Vista: leva os vínculos Setor × Gerente feitos com usuário
-- da intranet (145) para os gestores da database GESTORES do Pipefy (146), e
-- apaga a tabela antiga. Aplicar como postgres. Idempotente.
--
-- RODAR SÓ DEPOIS da 1ª leitura da GESTORES (abrir a tela de config ou esperar a
-- leitura agendada): com o espelho vazio nada casaria e os vínculos se perderiam,
-- então a migration aborta.
--
-- Casa pelo e-mail. Quem não casar (gerente que não está na database GESTORES)
-- some daqui: cadastrar no Pipefy e vincular de novo na tela.

DO $$
BEGIN
  IF to_regclass('public.tab_painel_setor_gerente') IS NULL THEN
    RAISE NOTICE 'tab_painel_setor_gerente já não existe — nada a migrar.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tab_painel_gestor) THEN
    RAISE EXCEPTION 'Espelho da database GESTORES vazio: faça a 1a leitura antes desta migration.';
  END IF;

  INSERT INTO tab_painel_setor_gestor (setor_id, gestor_id, criado_por, criado_em)
  SELECT g.setor_id, pg.record_id, g.criado_por, g.criado_em
    FROM tab_painel_setor_gerente g
    JOIN tab_intranet_usr u   ON u.id = g.id_user
    JOIN tab_painel_gestor pg ON pg.email = lower(trim(u.email))
  ON CONFLICT (setor_id, gestor_id) DO NOTHING;

  DROP TABLE tab_painel_setor_gerente;
END $$;

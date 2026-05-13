-- Compras - Solicitar Compra (Onda 1)
-- Tela na Intranet pra abrir SC sem precisar logar no Protheus.
-- Chama POST /SolicCompra/incluir (WSRESTFUL custom Develsoft) — formato MIT072.
-- Aprovacao continua no Protheus (SCR/SAL) e a SC ja aparece em
-- "Minhas Aprovacoes" da Intranet pra quem tem alcada.

-- Permissao 4004: pode criar SC pela Intranet
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (4004, 'Compras - Solicitar Compra', 'Compras')
ON CONFLICT (id_permissao) DO NOTHING;

-- Atribui ao admin (id=1)
INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao)
SELECT 1, 4004
 WHERE EXISTS (SELECT 1 FROM tab_intranet_usr WHERE id = 1)
   AND NOT EXISTS (
     SELECT 1 FROM tab_intranet_usr_permissoes
      WHERE id_user = 1 AND id_permissao = 4004
   );

-- Log de tentativas de criacao de SC. Mantem rastro completo (payload + response)
-- pra auditoria e rastreabilidade. Nao serve como fonte da verdade — a SC
-- vive no Protheus (SC1010) com numero retornado em sc_numero.
CREATE TABLE IF NOT EXISTS tab_sc_intranet_log (
    id              SERIAL PRIMARY KEY,
    criado_em       timestamp NOT NULL DEFAULT NOW(),
    id_user         int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    usuario_email   varchar(150),
    usuario_nome    varchar(120),
    -- Conteudo do request enviado pro Protheus (header + itens)
    payload         jsonb NOT NULL,
    -- Response completo do Protheus (STATUS + INCONSISTENCIAS + SC_GERADAS)
    response        jsonb,
    http_status     int,
    -- Numero da SC criada (do array SC_GERADAS[0]). NULL quando rejeitada/erro
    sc_numero       varchar(20),
    -- SUCESSO | REJEITADA | ERRO_SISTEMA
    status          varchar(20) NOT NULL,
    -- Resumo curto do erro (pra listagens) quando status != SUCESSO
    mensagem_erro   varchar(500),
    -- Tempo total da chamada (ms — medido no node, nao do STATUS.DURACAO)
    duracao_ms      int
);
CREATE INDEX IF NOT EXISTS ix_sc_intra_user   ON tab_sc_intranet_log (id_user, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_sc_intra_status ON tab_sc_intranet_log (status, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_sc_intra_scnum  ON tab_sc_intranet_log (sc_numero) WHERE sc_numero IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_sc_intranet_log TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_sc_intranet_log_id_seq TO intranet;

COMMENT ON TABLE tab_sc_intranet_log IS
    'Log de tentativas de criacao de SC via Intranet. SC eh criada no Protheus via REST custom Develsoft — esta tabela so guarda historico/auditoria.';

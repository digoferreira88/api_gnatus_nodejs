-- Financeiro - Liberação Financeira (Onda 1: organizar/rastrear)
-- Substitui o processo manual (planilha de carteira -> tabela dinâmica) por uma
-- tela que lista os pedidos "Aguardando liberação do Financeiro"
-- (pedidos_estatus.estatus_cod = 20) com o resumo financeiro de cada um, e
-- permite a operadora cadastrar 2 campos de trabalho por pedido:
--   - acoes:       texto livre (ex: "voltou pro comercial", "depende de fulano")
--   - observacoes: texto livre
-- Compartilhados entre os operadores (1 registro por pedido).
--
-- A liberação efetiva continua sendo feita no Protheus (Onda 2 futura fará o
-- write-back via REST custom Diego). Esta tabela é só apoio operacional —
-- a verdade dos pedidos vive no Protheus (SC5/SC6/SC9).

-- Permissao 8006: acesso ao módulo de Liberação Financeira
INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo) VALUES
  (8006, 'Financeiro - Liberação Financeira', 'Financeiro')
ON CONFLICT (id_permissao) DO NOTHING;

-- Atribui ao admin (id=1)
INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao)
SELECT 1, 8006
 WHERE EXISTS (SELECT 1 FROM tab_intranet_usr WHERE id = 1)
   AND NOT EXISTS (
     SELECT 1 FROM tab_intranet_usr_permissoes
      WHERE id_user = 1 AND id_permissao = 8006
   );

-- Anotações de trabalho por pedido (1 linha por pedido, filial fixa '01').
CREATE TABLE IF NOT EXISTS tab_lib_financeira_anotacao (
    id                   SERIAL PRIMARY KEY,
    filial               varchar(4)  NOT NULL DEFAULT '01',
    pedido               varchar(10) NOT NULL,
    acoes                text,
    observacoes          text,
    atualizado_por       int REFERENCES tab_intranet_usr(id) ON DELETE SET NULL,
    atualizado_por_nome  varchar(120),                 -- snapshot pra exibir sem join
    criado_em            timestamp NOT NULL DEFAULT NOW(),
    atualizado_em        timestamp NOT NULL DEFAULT NOW(),
    UNIQUE (filial, pedido)
);
CREATE INDEX IF NOT EXISTS ix_lib_fin_pedido ON tab_lib_financeira_anotacao (pedido);

GRANT SELECT, INSERT, UPDATE, DELETE ON tab_lib_financeira_anotacao TO intranet;
GRANT USAGE, SELECT ON SEQUENCE tab_lib_financeira_anotacao_id_seq TO intranet;

COMMENT ON TABLE tab_lib_financeira_anotacao IS
    'Anotações de trabalho (acoes/observacoes) por pedido na tela de Liberação Financeira. Apoio operacional — a liberação efetiva é feita no Protheus.';

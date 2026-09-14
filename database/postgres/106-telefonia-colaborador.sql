-- Estágio 1 do controle Linhas × Colaborador: a linha passa a apontar pro
-- colaborador do Protheus (SRA010) de forma canônica. `pessoa` (nome) e
-- `codigo_protheus` (matrícula RA_MAT) já existiam; falta o CPF (RA_CIC) como
-- chave estável de vínculo (o nome varia/repete; a matrícula pode repetir entre
-- filiais). Preenchido pelo autocomplete rh/colaboradores na tela da linha.
-- Aditivo e idempotente. `pessoa` segue existindo (nome exibido + fallback livre
-- p/ linha sem colaborador Protheus).

ALTER TABLE tab_telefonia_linha ADD COLUMN IF NOT EXISTS documento_colaborador varchar(20);
CREATE INDEX IF NOT EXISTS ix_tel_linha_doc ON tab_telefonia_linha (documento_colaborador);

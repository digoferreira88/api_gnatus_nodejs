-- Termo de Responsabilidade: 1 termo agora pode ter N dispositivos
-- (ex: computador + monitor entregues juntos no mesmo termo).
-- Tabela filha. Os campos antigos (marca/modelo/cor/novo/condicoes) em
-- tab_termo_equipamento ficam mantidos como SNAPSHOT do 1o dispositivo
-- pra retrocompatibilidade do historico antigo.

CREATE TABLE IF NOT EXISTS tab_termo_dispositivo (
    id          SERIAL PRIMARY KEY,
    id_termo    int NOT NULL REFERENCES tab_termo_equipamento(id) ON DELETE CASCADE,
    ordem       int NOT NULL DEFAULT 0,
    marca       varchar(80),
    modelo      varchar(80),
    cor         varchar(40),
    novo        boolean,
    condicoes   text
);
CREATE INDEX IF NOT EXISTS ix_termo_disp_termo ON tab_termo_dispositivo (id_termo, ordem);

-- Backfill: cada termo antigo que tem marca/modelo vira 1 dispositivo (ordem=0).
-- Idempotente: nao re-insere se ja existe dispositivo pro termo.
INSERT INTO tab_termo_dispositivo (id_termo, ordem, marca, modelo, cor, novo, condicoes)
SELECT t.id, 0, t.marca, t.modelo, t.cor, t.novo, t.condicoes
  FROM tab_termo_equipamento t
 WHERE (t.marca IS NOT NULL AND t.marca <> '' OR t.modelo IS NOT NULL AND t.modelo <> '')
   AND NOT EXISTS (SELECT 1 FROM tab_termo_dispositivo d WHERE d.id_termo = t.id);

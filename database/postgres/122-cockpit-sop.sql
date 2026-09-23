-- 122 — Cockpit S&OP (Compras/Planejamento) — 22/09/2026
--
-- Segundo painel entregue pelo setor de Compras. A intranet passa a servir o objeto
-- `D` a partir do Protheus (services/cockpitSop.js + cockpitSopMontar.js) no lugar
-- dos 4 uploads. Contrato: docs/compras/gnatus_cockpit_sop_CONTEXTO.md
--
--   tab_sop_meta              meta anual de faturamento (era constante no HTML)
--   tab_sop_entrada_snapshot  foto mensal da entrada, para medir o Demand Bias
--   permissão 4008

CREATE TABLE IF NOT EXISTS tab_sop_meta (
  ano               INTEGER PRIMARY KEY,
  meta_faturamento  NUMERIC(16,2) NOT NULL,
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_por    INTEGER
);

COMMENT ON TABLE tab_sop_meta IS
  'Meta anual de faturamento do Cockpit S&OP. Sem linha para o ano, o painel usa R$ 130 mi (a constante que estava no HTML do setor).';

-- A entrada é revisada retroativamente, sempre para baixo (o setor mediu −1,14% em
-- 9 meses). Cada geração grava o valor que enxerga de cada mês FECHADO; o Demand
-- Bias é a comparação da foto mais nova com a primeira.
CREATE TABLE IF NOT EXISTS tab_sop_entrada_snapshot (
  ano_mes   CHAR(6) NOT NULL,
  ref_data  DATE    NOT NULL,
  valor     NUMERIC(16,2) NOT NULL,
  PRIMARY KEY (ano_mes, ref_data)
);

COMMENT ON TABLE tab_sop_entrada_snapshot IS
  'Foto da entrada (pedidos) por mês fechado a cada geração do cockpit. É a única fonte do Demand Bias — não dá para derivar de uma consulta só.';

INSERT INTO tab_intranet_permissoes (id_permissao, nome, modulo)
VALUES (4008, 'Compras - Cockpit S&OP', 'Compras')
ON CONFLICT (id_permissao) DO NOTHING;

-- Meta de 2026 combinada com o setor (estava fixa no arquivo como META_FAT26).
INSERT INTO tab_sop_meta (ano, meta_faturamento)
VALUES (2026, 130000000.00)
ON CONFLICT (ano) DO NOTHING;

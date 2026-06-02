// CTE reutilizavel pro TEMPO DE PERMANENCIA por fase (lead time).
//
// Definicao (alinhada com o financeiro/produção 2026-06):
//   tempo na fase N = (conclusao da fase N) - (conclusao da fase anterior na
//   linha do tempo do registro). Ou seja, da ENTRADA na fase (etapa anterior
//   aprovada) ate a SAIDA (esta aprovada). Inclui fila + trabalho ativo, que
//   eh o que o "tempo que o produto ficou na fase" realmente significa.
//
// Retrabalho: se a fase foi reprovada e reaprovada, ela aparece com mais de um
//   evento de conclusao -> as duas passagens somam ("somar todas as passagens").
//
// Fonte dos eventos de conclusao:
//   1) tab_prod_registro_etapa_log (status_para='aprovado') -> timestamp PRECISO
//   2) fallback tab_prod_registro_etapa.data_execucao (granularidade DIA) pra
//      etapas aprovadas que NAO tem evento no log (dados historicos / criados
//      fora do fluxo de avanco de fase). Marcadas com estimado=true.
//   Ancora: "fase 0" = inicio do processo (data_inicio_prev ou criado_em),
//   pra a fase 1 ter de onde contar.
//
// Saida da CTE `fase_evento`: 1 linha por CONCLUSAO de etapa, com
//   (registro_id, etapa_codigo, ts, responsavel_id, estimado, segundos).

const CTE_TEMPO_FASE = `
  WITH eventos AS (
    -- ancora do inicio do processo (fase 0)
    SELECT r.id AS registro_id, 0 AS etapa_codigo,
           COALESCE(r.data_inicio_prev::timestamp, r.criado_em) AS ts,
           NULL::int AS responsavel_id, false AS estimado
      FROM tab_prod_registro r
    UNION ALL
    -- conclusoes PRECISAS (log de transicoes)
    SELECT l.registro_id, l.etapa_codigo, l.mudou_em AS ts,
           l.responsavel_id, false AS estimado
      FROM tab_prod_registro_etapa_log l
     WHERE l.status_para = 'aprovado'
    UNION ALL
    -- conclusoes HISTORICAS (data_execucao) so pras etapas sem evento no log
    SELECT e.registro_id, e.etapa_codigo, e.data_execucao::timestamp AS ts,
           e.responsavel_id, true AS estimado
      FROM tab_prod_registro_etapa e
     WHERE e.status = 'aprovado' AND e.data_execucao IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM tab_prod_registro_etapa_log l
          WHERE l.registro_id = e.registro_id
            AND l.etapa_codigo = e.etapa_codigo
            AND l.status_para = 'aprovado')
  ),
  ordenado AS (
    SELECT registro_id, etapa_codigo, ts, responsavel_id, estimado,
           LAG(ts) OVER (PARTITION BY registro_id ORDER BY ts, etapa_codigo) AS ts_ant
      FROM eventos
  ),
  fase_evento AS (
    SELECT registro_id, etapa_codigo, ts, responsavel_id, estimado,
           EXTRACT(EPOCH FROM (ts - ts_ant))::numeric(14,2) AS segundos
      FROM ordenado
     WHERE etapa_codigo > 0          -- descarta a ancora
       AND ts_ant IS NOT NULL
       AND ts >= ts_ant              -- guarda contra timestamps fora de ordem
  )
`;

module.exports = { CTE_TEMPO_FASE };

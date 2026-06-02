// GET /producao/gestao/tempo-fase
// Tempo de PERMANENCIA por fase (lead time) — quanto tempo, em media, um
// produto fica em cada uma das 12 fases (da entrada na fase ate a aprovacao),
// incluindo fila + retrabalho. Complementa o /gestao/dashboard, que media so
// o trabalho ativo (em_andamento -> aprovado).
//
// Filtros (query): dataIni, dataFim (YYYY-MM-DD, por data de CONCLUSAO da fase;
//   default ultimos 90d), colaboradorId (quem aprovou), etapaCodigo (1..12).
//
// Resposta:
//   porFase[]  : { etapa_codigo, etapa_nome, ops, media_seg, mediana_seg,
//                  p90_seg, min_seg, max_seg, tem_estimado }
//   geral      : { ops_distintas, lead_total_medio_seg, tem_estimado }
//
// Permissao 14002 (Producao - Admin).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14002]);
const { CTE_TEMPO_FASE } = require('./_tempoFase');
const { ETAPAS } = require('./_etapas');

const NOME_POR_CODIGO = {};
(ETAPAS || []).forEach(e => { NOME_POR_CODIGO[e.codigo] = e.nome; });

module.exports = (app) => ({
  verb: 'get',
  route: '/gestao/tempo-fase',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const hoje = new Date();
      const ha90d = new Date(hoje.getTime() - 90 * 86400000);
      const dataIni = String(req.query.dataIni || ha90d.toISOString().slice(0, 10));
      const dataFim = String(req.query.dataFim || hoje.toISOString().slice(0, 10));
      const colaboradorId = req.query.colaboradorId ? Number(req.query.colaboradorId) : null;
      const etapaCodigo = req.query.etapaCodigo ? Number(req.query.etapaCodigo) : null;

      const params = { di: dataIni, df: dataFim, cid: colaboradorId, ec: etapaCodigo };
      const condColab = colaboradorId ? 'AND fe.responsavel_id = @cid' : '';
      const condEtapa = etapaCodigo ? 'AND fe.etapa_codigo = @ec' : '';
      // Periodo aplicado na data de conclusao da fase
      const condPeriodo = 'AND fe.ts >= @di::date AND fe.ts < (@df::date + 1)';

      // Soma por (registro, etapa) -> tempo total da fase pra cada OP (com
      // retrabalho somado). Depois agrega por etapa (media/mediana/p90 sobre as
      // OPs).
      const porFase = await Pg.connectAndQuery(`
        ${CTE_TEMPO_FASE},
        por_op AS (
          SELECT fe.registro_id, fe.etapa_codigo,
                 SUM(fe.segundos)   AS segundos_total,
                 BOOL_OR(fe.estimado) AS estimado
            FROM fase_evento fe
           WHERE 1=1 ${condPeriodo} ${condColab} ${condEtapa}
           GROUP BY fe.registro_id, fe.etapa_codigo
        )
        SELECT etapa_codigo,
               COUNT(*)                                                            AS ops,
               AVG(segundos_total)::numeric(14,2)                                  AS media_seg,
               PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY segundos_total)::numeric(14,2) AS mediana_seg,
               PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY segundos_total)::numeric(14,2) AS p90_seg,
               MIN(segundos_total)::numeric(14,2)                                  AS min_seg,
               MAX(segundos_total)::numeric(14,2)                                  AS max_seg,
               BOOL_OR(estimado)                                                   AS tem_estimado
          FROM por_op
         GROUP BY etapa_codigo
         ORDER BY etapa_codigo`,
        params
      );

      // Lead time TOTAL por OP (soma de todas as fases) -> media geral.
      const geral = await Pg.connectAndQuery(`
        ${CTE_TEMPO_FASE},
        por_op AS (
          SELECT fe.registro_id, SUM(fe.segundos) AS segundos_total,
                 BOOL_OR(fe.estimado) AS estimado
            FROM fase_evento fe
           WHERE 1=1 ${condPeriodo} ${condColab} ${condEtapa}
           GROUP BY fe.registro_id
        )
        SELECT COUNT(*) AS ops_distintas,
               AVG(segundos_total)::numeric(14,2) AS lead_total_medio_seg,
               BOOL_OR(estimado) AS tem_estimado
          FROM por_op`,
        params
      );

      return res.json({
        filtro: { dataIni, dataFim, colaboradorId, etapaCodigo },
        porFase: porFase.map(r => ({
          etapa_codigo: Number(r.etapa_codigo),
          etapa_nome: NOME_POR_CODIGO[Number(r.etapa_codigo)] || `Etapa ${r.etapa_codigo}`,
          ops: Number(r.ops),
          media_seg: Number(r.media_seg || 0),
          mediana_seg: Number(r.mediana_seg || 0),
          p90_seg: Number(r.p90_seg || 0),
          min_seg: Number(r.min_seg || 0),
          max_seg: Number(r.max_seg || 0),
          tem_estimado: r.tem_estimado === true
        })),
        geral: {
          ops_distintas: Number(geral[0]?.ops_distintas || 0),
          lead_total_medio_seg: Number(geral[0]?.lead_total_medio_seg || 0),
          tem_estimado: geral[0]?.tem_estimado === true
        }
      });
    } catch (err) {
      console.error('producao/gestao-tempo-fase:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

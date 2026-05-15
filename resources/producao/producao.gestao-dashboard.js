// GET /producao/gestao/dashboard
// Submodulo de Gestao da Producao — KPIs + ranking colaboradores +
// tempo medio + gargalo por etapa + serie temporal.
//
// Filtros via query:
//   dataIni, dataFim (YYYY-MM-DD) — janela de analise. Default = ultimos 30d.
//   colaboradorId (opcional) — restringe a 1 user.
//   etapaCodigo (opcional, 1..12) — restringe a 1 etapa do processo.
//
// Permissao: 14002 (Producao - Admin).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14002]);

module.exports = (app) => ({
  verb: 'get',
  route: '/gestao/dashboard',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const hoje = new Date();
      const ha30d = new Date(hoje.getTime() - 30 * 86400000);
      const dataIni = String(req.query.dataIni || ha30d.toISOString().slice(0, 10));
      const dataFim = String(req.query.dataFim || hoje.toISOString().slice(0, 10));
      const colaboradorId = req.query.colaboradorId ? Number(req.query.colaboradorId) : null;
      const etapaCodigo = req.query.etapaCodigo ? Number(req.query.etapaCodigo) : null;

      const params = { di: dataIni, df: dataFim, cid: colaboradorId, ec: etapaCodigo };
      const condColab = colaboradorId ? 'AND l.responsavel_id = @cid' : '';
      const condEtapa = etapaCodigo ? 'AND l.etapa_codigo = @ec' : '';
      const condPeriodo = `AND l.mudou_em >= @di::date AND l.mudou_em < (@df::date + 1)`;

      // ============== 1. KPIs topo ==============
      // Etapas concluidas (aprovadas + reprovadas) no periodo, total e por status
      const kpiQuery = await Pg.connectAndQuery(`
        SELECT
          COUNT(*)                                                                         AS transicoes,
          COUNT(*) FILTER (WHERE l.status_para = 'aprovado')                               AS aprovadas,
          COUNT(*) FILTER (WHERE l.status_para = 'reprovado')                              AS reprovadas,
          COUNT(*) FILTER (WHERE l.status_para = 'em_andamento')                           AS iniciadas,
          COUNT(DISTINCT l.responsavel_id) FILTER (WHERE l.status_para IN ('aprovado','reprovado')) AS colaboradores_ativos,
          COUNT(DISTINCT l.registro_id)                                                    AS ops_envolvidas
        FROM tab_prod_registro_etapa_log l
        WHERE 1=1 ${condPeriodo} ${condColab} ${condEtapa}`,
        params
      );
      const kpis = kpiQuery[0] || {};

      // Etapas em aberto AGORA (status pendente ou em_andamento) com responsavel atribuido
      const emAberto = await Pg.connectAndQuery(`
        SELECT COUNT(*) AS qtd
          FROM tab_prod_registro_etapa e
          JOIN tab_prod_registro r ON r.id = e.registro_id
         WHERE r.status = 'aberto'
           AND e.status IN ('pendente', 'em_andamento')
           AND e.responsavel_id IS NOT NULL
           ${colaboradorId ? 'AND e.responsavel_id = @cid' : ''}
           ${etapaCodigo ? 'AND e.etapa_codigo = @ec' : ''}`,
        params
      );
      kpis.em_aberto_agora = Number(emAberto[0]?.qtd || 0);

      // Tempo medio entre "em_andamento" e "aprovado/reprovado" — por par
      // (registro, etapa). Pega a transicao mais recente pra cada par.
      const tempoMedio = await Pg.connectAndQuery(`
        WITH inicios AS (
          SELECT DISTINCT ON (registro_etapa_id)
                 registro_etapa_id, mudou_em AS inicio_em, responsavel_id
            FROM tab_prod_registro_etapa_log
           WHERE status_para = 'em_andamento'
           ORDER BY registro_etapa_id, mudou_em DESC
        ),
        fins AS (
          SELECT DISTINCT ON (registro_etapa_id)
                 registro_etapa_id, mudou_em AS fim_em, status_para
            FROM tab_prod_registro_etapa_log
           WHERE status_para IN ('aprovado','reprovado')
           ORDER BY registro_etapa_id, mudou_em DESC
        )
        SELECT
          AVG(EXTRACT(EPOCH FROM (f.fim_em - i.inicio_em)))::numeric(12,2) AS segundos_medio,
          COUNT(*) AS amostras
          FROM inicios i
          JOIN fins f ON f.registro_etapa_id = i.registro_etapa_id
          JOIN tab_prod_registro_etapa_log lf ON lf.registro_etapa_id = f.registro_etapa_id AND lf.mudou_em = f.fim_em
         WHERE f.fim_em > i.inicio_em
           AND f.fim_em >= @di::date AND f.fim_em < (@df::date + 1)
           ${colaboradorId ? 'AND i.responsavel_id = @cid' : ''}
           ${etapaCodigo ? 'AND lf.etapa_codigo = @ec' : ''}`,
        params
      );
      kpis.tempo_medio_segundos = Number(tempoMedio[0]?.segundos_medio || 0);
      kpis.tempo_medio_amostras = Number(tempoMedio[0]?.amostras || 0);

      // ============== 2. Ranking colaboradores ==============
      const ranking = await Pg.connectAndQuery(`
        SELECT
          u.id, u.nome, u.email,
          COUNT(*) FILTER (WHERE l.status_para = 'aprovado')   AS aprovadas,
          COUNT(*) FILTER (WHERE l.status_para = 'reprovado')  AS reprovadas,
          COUNT(*) FILTER (WHERE l.status_para = 'em_andamento') AS iniciadas,
          COUNT(DISTINCT l.registro_id)                        AS ops_distintas,
          MAX(l.mudou_em)                                      AS ultima_atividade
        FROM tab_prod_registro_etapa_log l
        JOIN tab_intranet_usr u ON u.id = l.responsavel_id
        WHERE 1=1 ${condPeriodo} ${condEtapa}
          ${colaboradorId ? 'AND l.responsavel_id = @cid' : ''}
        GROUP BY u.id, u.nome, u.email
        ORDER BY aprovadas DESC, reprovadas DESC
        LIMIT 50`,
        params
      );

      // ============== 3. Gargalo por etapa ==============
      // Tempo medio por etapa do processo (1..12) + qtd transicoes
      const gargalo = await Pg.connectAndQuery(`
        WITH inicios AS (
          SELECT DISTINCT ON (registro_etapa_id)
                 registro_etapa_id, etapa_codigo, mudou_em AS inicio_em
            FROM tab_prod_registro_etapa_log
           WHERE status_para = 'em_andamento'
           ORDER BY registro_etapa_id, mudou_em DESC
        ),
        fins AS (
          SELECT DISTINCT ON (registro_etapa_id)
                 registro_etapa_id, mudou_em AS fim_em, status_para
            FROM tab_prod_registro_etapa_log
           WHERE status_para IN ('aprovado','reprovado')
           ORDER BY registro_etapa_id, mudou_em DESC
        )
        SELECT
          i.etapa_codigo,
          AVG(EXTRACT(EPOCH FROM (f.fim_em - i.inicio_em)))::numeric(12,2) AS segundos_medio,
          COUNT(*) AS amostras,
          COUNT(*) FILTER (WHERE f.status_para = 'reprovado') AS reprovacoes
          FROM inicios i
          JOIN fins f ON f.registro_etapa_id = i.registro_etapa_id
         WHERE f.fim_em > i.inicio_em
           AND f.fim_em >= @di::date AND f.fim_em < (@df::date + 1)
        GROUP BY i.etapa_codigo
        ORDER BY i.etapa_codigo`,
        params
      );

      // ============== 4. Serie temporal — etapas concluidas por dia ==============
      const serieTemporal = await Pg.connectAndQuery(`
        SELECT DATE(l.mudou_em) AS dia,
               COUNT(*) FILTER (WHERE l.status_para = 'aprovado')  AS aprovadas,
               COUNT(*) FILTER (WHERE l.status_para = 'reprovado') AS reprovadas
          FROM tab_prod_registro_etapa_log l
         WHERE l.status_para IN ('aprovado','reprovado')
           ${condPeriodo}
           ${colaboradorId ? 'AND l.responsavel_id = @cid' : ''}
           ${etapaCodigo ? 'AND l.etapa_codigo = @ec' : ''}
         GROUP BY DATE(l.mudou_em)
         ORDER BY dia`,
        params
      );

      return res.json({
        filtro: { dataIni, dataFim, colaboradorId, etapaCodigo },
        kpis: {
          aprovadas: Number(kpis.aprovadas || 0),
          reprovadas: Number(kpis.reprovadas || 0),
          iniciadas: Number(kpis.iniciadas || 0),
          transicoes: Number(kpis.transicoes || 0),
          colaboradores_ativos: Number(kpis.colaboradores_ativos || 0),
          ops_envolvidas: Number(kpis.ops_envolvidas || 0),
          em_aberto_agora: kpis.em_aberto_agora,
          tempo_medio_segundos: kpis.tempo_medio_segundos,
          tempo_medio_amostras: kpis.tempo_medio_amostras
        },
        ranking: ranking.map(r => ({
          id: r.id, nome: r.nome, email: r.email,
          aprovadas: Number(r.aprovadas), reprovadas: Number(r.reprovadas),
          iniciadas: Number(r.iniciadas), ops_distintas: Number(r.ops_distintas),
          ultima_atividade: r.ultima_atividade
        })),
        gargalo: gargalo.map(g => ({
          etapa_codigo: Number(g.etapa_codigo),
          segundos_medio: Number(g.segundos_medio || 0),
          amostras: Number(g.amostras),
          reprovacoes: Number(g.reprovacoes)
        })),
        serie_temporal: serieTemporal.map(s => ({
          dia: String(s.dia).slice(0, 10),
          aprovadas: Number(s.aprovadas),
          reprovadas: Number(s.reprovadas)
        }))
      });
    } catch (err) {
      console.error('producao/gestao-dashboard:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

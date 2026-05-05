// GET /controladoria/pt/dashboard — KPIs e agregacoes do controle operacional.
// Permissao 11003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/pt/dashboard',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      // KPIs gerais
      const kpis = await Pg.connectAndQuery(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'EM_ABERTO')                AS qt_em_aberto,
          COUNT(*) FILTER (WHERE status = 'PARCIAL')                  AS qt_parcial,
          COUNT(*) FILTER (WHERE status = 'FINALIZADO')               AS qt_finalizado,
          COUNT(*) FILTER (
            WHERE status <> 'FINALIZADO'
              AND data_vencimento IS NOT NULL
              AND data_vencimento < CURRENT_DATE)                     AS qt_em_atraso,
          COUNT(*)                                                    AS qt_total,
          COALESCE(SUM(valor) FILTER (WHERE status <> 'FINALIZADO'), 0) AS valor_em_aberto,
          COALESCE(SUM(valor), 0)                                       AS valor_total,
          COALESCE(AVG(
            CASE WHEN status <> 'FINALIZADO' AND data_expedicao IS NOT NULL
                 THEN (CURRENT_DATE - data_expedicao) END), 0)        AS dias_medio_em_aberto
        FROM tab_pt_envio`, {}
      );

      // Tempo medio fora pra envios JA finalizados (data_expedicao -> data ultima finalizacao)
      const tempoFora = await Pg.connectAndQuery(`
        SELECT AVG(diff)::numeric(10,1) AS dias_medio_fora
          FROM (
            SELECT (MAX(f.data_finalizacao) - e.data_expedicao) AS diff
              FROM tab_pt_envio e
              JOIN tab_pt_finalizacao f ON f.envio_id = e.id
             WHERE e.status = 'FINALIZADO' AND e.data_expedicao IS NOT NULL
             GROUP BY e.id, e.data_expedicao
          ) sub WHERE diff >= 0`, {}
      );

      // Taxa de retorno x venda (entre os finalizados)
      const taxas = await Pg.connectAndQuery(`
        SELECT
          COUNT(*) FILTER (WHERE forma = 'RETORNO')   AS qt_retornos,
          COUNT(*) FILTER (WHERE forma = 'VENDA')     AS qt_vendas,
          COUNT(*) FILTER (WHERE forma = 'RENOVACAO') AS qt_renovacoes,
          COUNT(*) FILTER (WHERE forma = 'TROCA')     AS qt_trocas,
          COUNT(*) FILTER (WHERE forma = 'PARCIAL')   AS qt_parciais,
          COUNT(*)                                    AS qt_finalizacoes,
          COALESCE(SUM(valor_venda) FILTER (WHERE forma = 'VENDA'), 0) AS valor_vendas
        FROM tab_pt_finalizacao`, {}
      );

      // Por finalidade
      const porFinalidade = await Pg.connectAndQuery(`
        SELECT COALESCE(NULLIF(finalidade,''), '(sem)') AS finalidade,
               COUNT(*) AS qt,
               COUNT(*) FILTER (WHERE status <> 'FINALIZADO') AS qt_em_aberto,
               COALESCE(SUM(valor), 0) AS valor
          FROM tab_pt_envio
         GROUP BY 1
         ORDER BY qt DESC`, {}
      );

      // Top 10 destinatarios em aberto (por valor)
      const topDestinatarios = await Pg.connectAndQuery(`
        SELECT destinatario_nome, destinatario_cod, destinatario_loja,
               COUNT(*) AS qt, COALESCE(SUM(valor), 0) AS valor
          FROM tab_pt_envio
         WHERE status <> 'FINALIZADO'
         GROUP BY destinatario_nome, destinatario_cod, destinatario_loja
         ORDER BY valor DESC NULLS LAST
         LIMIT 10`, {}
      );

      const k = kpis[0] || {};
      const t = taxas[0] || {};
      const totalFin = Number(t.qt_finalizacoes || 0);
      const taxaRetorno = totalFin > 0 ? (Number(t.qt_retornos) / totalFin) * 100 : 0;
      const taxaVenda   = totalFin > 0 ? (Number(t.qt_vendas)   / totalFin) * 100 : 0;

      return res.json({
        kpis: {
          qt_em_aberto: Number(k.qt_em_aberto || 0),
          qt_parcial: Number(k.qt_parcial || 0),
          qt_finalizado: Number(k.qt_finalizado || 0),
          qt_em_atraso: Number(k.qt_em_atraso || 0),
          qt_total: Number(k.qt_total || 0),
          valor_em_aberto: Number(k.valor_em_aberto || 0),
          valor_total: Number(k.valor_total || 0),
          dias_medio_em_aberto: Number(k.dias_medio_em_aberto || 0),
          dias_medio_fora: Number(tempoFora[0]?.dias_medio_fora || 0),
          qt_retornos: Number(t.qt_retornos || 0),
          qt_vendas: Number(t.qt_vendas || 0),
          valor_vendas: Number(t.valor_vendas || 0),
          taxa_retorno: Number(taxaRetorno.toFixed(1)),
          taxa_venda: Number(taxaVenda.toFixed(1))
        },
        por_finalidade: porFinalidade,
        top_destinatarios: topDestinatarios,
        gerado_em: new Date().toISOString()
      });
    } catch (err) {
      console.error('pt-dashboard:', err);
      return res.status(500).json({ message: 'Erro ao montar dashboard.' });
    }
  }
});

// GET /controladoria/pt/envios — lista paginada com filtros + agregados.
// Query: ?status=EM_ABERTO|FINALIZADO|PARCIAL  ?finalidade=...
//        ?destinatario=...  ?atrasados=true  ?dataIni=YYYY-MM-DD  ?dataFim=...
//        ?limit=200 (max 2000)
// Permissao 11003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/pt/envios',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;

    const limit = Math.min(Math.max(Number(req.query.limit || 500), 1), 2000);
    const params = { lim: limit };
    const conds = [];

    if (req.query.status) {
      conds.push(`e.status = @status`);
      params.status = String(req.query.status).toUpperCase();
    }
    if (req.query.finalidade) {
      conds.push(`e.finalidade ILIKE @finalidade`);
      params.finalidade = String(req.query.finalidade);
    }
    if (req.query.destinatario) {
      conds.push(`(e.destinatario_nome ILIKE '%' || @dest || '%' OR e.destinatario_cod = @dest)`);
      params.dest = String(req.query.destinatario);
    }
    if (req.query.atrasados === 'true') {
      conds.push(`e.status <> 'FINALIZADO' AND e.data_vencimento IS NOT NULL AND e.data_vencimento < CURRENT_DATE`);
    }
    if (req.query.dataIni && /^\d{4}-\d{2}-\d{2}$/.test(req.query.dataIni)) {
      conds.push(`e.data_expedicao >= @ini::date`);
      params.ini = String(req.query.dataIni);
    }
    if (req.query.dataFim && /^\d{4}-\d{2}-\d{2}$/.test(req.query.dataFim)) {
      conds.push(`e.data_expedicao <= @fim::date`);
      params.fim = String(req.query.dataFim);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT
          e.id, e.destinatario_nome, e.destinatario_cod, e.destinatario_loja,
          e.pedido_protheus, e.solicitante_nome, e.responsavel_nome,
          e.finalidade, e.natureza_operacao, e.contrato_comodato,
          e.prazo_dias, e.ultima_validacao_em,
          e.data_emissao_nf, e.data_expedicao, e.data_vencimento,
          e.nf_saida, e.serie_saida, e.cfop_saida,
          e.valor, e.status,
          e.cobranca_1a, e.cobranca_2a, e.observacao,
          e.criado_em, e.atualizado_em, e.origem,
          (SELECT COUNT(*) FROM tab_pt_envio_item i  WHERE i.envio_id = e.id) AS qt_itens,
          (SELECT COUNT(*) FROM tab_pt_finalizacao f WHERE f.envio_id = e.id) AS qt_finalizacoes,
          CASE
            WHEN e.status = 'FINALIZADO' THEN NULL
            WHEN e.data_vencimento IS NOT NULL AND e.data_vencimento < CURRENT_DATE
              THEN (CURRENT_DATE - e.data_vencimento)
            ELSE NULL
          END AS dias_atraso
        FROM tab_pt_envio e
        ${where}
        ORDER BY
          CASE WHEN e.status = 'FINALIZADO' THEN 1 ELSE 0 END,
          COALESCE(e.data_vencimento, e.data_expedicao) DESC,
          e.id DESC
        LIMIT @lim`,
        params
      );

      return res.json({ envios: rows, total: rows.length, limite: limit });
    } catch (err) {
      console.error('pt-list:', err);
      return res.status(500).json({ message: 'Erro ao listar envios.' });
    }
  }
});

// GET /producao/gestao/em-andamento
// Tabela ao vivo de etapas em status pendente/em_andamento atribuidas a
// um responsavel. Mostra ha quanto tempo cada uma esta sem mudanca de
// status (alerta de etapa parada).
//
// Filtros:
//   colaboradorId (opcional)
//   etapaCodigo (opcional)
//   minHorasParada (opcional, default 0) — so mostra etapas paradas ha mais de X horas
//
// Permissao: 14002.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14002]);
const { ETAPAS } = require('./_etapas');

const NOMES_ETAPA = Object.fromEntries(ETAPAS.map(e => [e.codigo, e.nome]));

module.exports = (app) => ({
  verb: 'get',
  route: '/gestao/em-andamento',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const colaboradorId = req.query.colaboradorId ? Number(req.query.colaboradorId) : null;
      const etapaCodigo = req.query.etapaCodigo ? Number(req.query.etapaCodigo) : null;
      const minHorasParada = Number(req.query.minHorasParada || 0);

      const params = { cid: colaboradorId, ec: etapaCodigo, hmin: minHorasParada };

      // ULTIMA mudanca de status por etapa (do log) pra calcular tempo parado
      const rows = await Pg.connectAndQuery(`
        WITH ult AS (
          SELECT DISTINCT ON (registro_etapa_id)
                 registro_etapa_id, mudou_em
            FROM tab_prod_registro_etapa_log
           ORDER BY registro_etapa_id, mudou_em DESC
        )
        SELECT
          e.id              AS etapa_id,
          e.registro_id,
          e.etapa_codigo,
          e.status,
          e.responsavel_id,
          u.nome            AS responsavel_nome,
          u.email           AS responsavel_email,
          e.atualizado_em,
          ult.mudou_em      AS ultima_mudanca,
          r.op_protheus,
          r.produto_codigo,
          r.produto_descricao,
          r.fase_atual,
          EXTRACT(EPOCH FROM (NOW() - COALESCE(ult.mudou_em, e.atualizado_em, e.criado_em))) / 3600.0 AS horas_parada
        FROM tab_prod_registro_etapa e
        JOIN tab_prod_registro r ON r.id = e.registro_id
        LEFT JOIN tab_intranet_usr u ON u.id = e.responsavel_id
        LEFT JOIN ult ON ult.registro_etapa_id = e.id
        WHERE r.status = 'aberto'
          AND e.status IN ('pendente', 'em_andamento')
          AND e.responsavel_id IS NOT NULL
          ${colaboradorId ? 'AND e.responsavel_id = @cid' : ''}
          ${etapaCodigo ? 'AND e.etapa_codigo = @ec' : ''}
        ORDER BY horas_parada DESC NULLS LAST
        LIMIT 200`,
        params
      );

      const filtradas = minHorasParada > 0
        ? rows.filter(r => Number(r.horas_parada || 0) >= minHorasParada)
        : rows;

      return res.json({
        filtro: { colaboradorId, etapaCodigo, minHorasParada },
        total: filtradas.length,
        etapas: filtradas.map(r => ({
          etapa_id: r.etapa_id,
          registro_id: r.registro_id,
          op_protheus: r.op_protheus,
          produto_codigo: r.produto_codigo,
          produto_descricao: r.produto_descricao,
          fase_atual: r.fase_atual,
          etapa_codigo: r.etapa_codigo,
          etapa_nome: NOMES_ETAPA[r.etapa_codigo] || `Etapa ${r.etapa_codigo}`,
          status: r.status,
          responsavel_id: r.responsavel_id,
          responsavel_nome: r.responsavel_nome,
          responsavel_email: r.responsavel_email,
          ultima_mudanca: r.ultima_mudanca,
          horas_parada: Number(Number(r.horas_parada || 0).toFixed(2))
        }))
      });
    } catch (err) {
      console.error('producao/gestao-em-andamento:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

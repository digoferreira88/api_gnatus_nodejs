// PUT /controladoria/estoque-parametros/:tipo
//   :tipo = '_global' pra registro global (tipo_produto = NULL), ou codigo B1_TIPO
// Body: { lead_time_dias, nivel_servico, janela_demanda_meses }
// Permissao 11004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11004]);
const Auditoria = require('../../services/auditoria');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'put',
  route: '/estoque-parametros/:tipo',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const tipoParam = trim(req.params.tipo);
    const tipoFinal = tipoParam === '_global' || tipoParam === '' ? null : tipoParam;
    const b = req.body || {};

    const leadTime = Math.max(1, Math.min(365, N(b.lead_time_dias) || 30));
    const z = Math.max(0.5, Math.min(3.5, N(b.nivel_servico) || 1.65));
    const janela = Math.max(1, Math.min(24, N(b.janela_demanda_meses) || 6));

    try {
      const r = await Pg.connectAndQuery(`
        INSERT INTO tab_estoque_parametros (tipo_produto, lead_time_dias, nivel_servico, janela_demanda_meses, atualizado_em)
        VALUES (@tipo, @lt, @z, @j, NOW())
        ON CONFLICT (tipo_produto)
        DO UPDATE SET
          lead_time_dias = EXCLUDED.lead_time_dias,
          nivel_servico  = EXCLUDED.nivel_servico,
          janela_demanda_meses = EXCLUDED.janela_demanda_meses,
          atualizado_em  = NOW()
        RETURNING id, tipo_produto, lead_time_dias, nivel_servico, janela_demanda_meses`,
        { tipo: tipoFinal, lt: leadTime, z, j: janela }
      );

      Auditoria.registrar(app, {
        modulo: 'Controladoria', submodulo: 'EstoqueParametros',
        acao: 'UPSERT', severidade: 'INFO',
        req, entidade: 'estoque_parametro', entidadeId: tipoFinal || '_global',
        descricao: `Atualizou parametros de estoque para ${tipoFinal || 'global'} (LT=${leadTime}, z=${z}, janela=${janela}m)`,
        meta: { tipo: tipoFinal, lead_time_dias: leadTime, nivel_servico: z, janela_demanda_meses: janela }
      });

      return res.json({ ok: true, parametro: r[0] });
    } catch (err) {
      console.error('estoque-parametros PUT:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

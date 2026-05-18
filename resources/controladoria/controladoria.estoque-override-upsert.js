// PUT /controladoria/estoque-produto-override/:cod
// Upsert dos parametros manuais. Permissao 11004.
//
// Body: { leadTimeOverride?, demandaMensalManual?, estoqueSegurancaManual?, observacao? }
// Campo NULL apaga aquele override (volta a usar calculo automatico).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11004]);
const Auditoria = require('../../services/auditoria');

const NN = (v) => v == null || v === '' ? null : Number(v);
const T = (v) => v == null ? null : String(v).trim();

module.exports = (app) => ({
  verb: 'put',
  route: '/estoque-produto-override/:cod',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const cod = String(req.params.cod || '').trim();
    if (!cod) return res.status(400).json({ message: 'codigo obrigatorio.' });

    const ltOver  = NN(req.body?.leadTimeOverride);
    const demanda = NN(req.body?.demandaMensalManual);
    const seg     = NN(req.body?.estoqueSegurancaManual);
    const obs     = T(req.body?.observacao);

    if (ltOver != null && (!Number.isFinite(ltOver) || ltOver < 0 || ltOver > 365)) {
      return res.status(400).json({ message: 'lead_time invalido (0..365 dias).' });
    }
    if (demanda != null && (!Number.isFinite(demanda) || demanda < 0)) {
      return res.status(400).json({ message: 'demanda nao pode ser negativa.' });
    }
    if (seg != null && (!Number.isFinite(seg) || seg < 0)) {
      return res.status(400).json({ message: 'estoque_seguranca nao pode ser negativo.' });
    }

    const existe = await Pg.connectAndQuery(
      `SELECT 1 FROM tab_estoque_produto_meta WHERE cod_produto = @cod`, { cod }
    );
    if (!existe.length) {
      return res.status(404).json({ message: 'Produto nao esta no cache. Rode o snapshot primeiro.' });
    }

    try {
      await Pg.connectAndQuery(`
        UPDATE tab_estoque_produto_meta
           SET lead_time_override       = @lt,
               demanda_mensal_manual    = @dem,
               estoque_seguranca_manual = @seg,
               observacao_manual        = @obs,
               atualizado_por           = @uid,
               manual_em                = NOW()
         WHERE cod_produto = @cod`,
        { cod, lt: ltOver, dem: demanda, seg, obs, uid: user.ID }
      );

      Auditoria.registrar(app, {
        modulo: 'Controladoria', submodulo: 'EstoqueOverride', acao: 'UPSERT',
        severidade: 'INFO', req,
        entidade: 'estoque_produto_meta', entidadeId: cod,
        descricao: `Atualizou parametros manuais do produto ${cod}`,
        meta: { lead_time: ltOver, demanda, seguranca: seg }
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('estoque-override-upsert:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

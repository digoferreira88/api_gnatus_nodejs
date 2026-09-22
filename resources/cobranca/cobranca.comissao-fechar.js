// POST /cobranca/comissao/fechar { anoMes, reabrir? } — congela (ou reabre) a
// comissão apurada de um mês, p/ o financeiro/RH pagar sem recalcular. Perm 9005.
const Comissao = require('../../services/cobrancaComissao');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9005, 0]);

module.exports = (app) => ({
  verb: 'post',
  route: '/comissao/fechar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const anoMes = /^\d{6}$/.test(req.body && req.body.anoMes) ? String(req.body.anoMes) : '';
    if (!anoMes) return res.status(400).json({ message: 'anoMes (YYYYMM) é obrigatório.' });
    const reabrir = req.body && (req.body.reabrir === true || req.body.reabrir === 1 || req.body.reabrir === '1');

    try {
      const cfg = await Comissao.carregarConfig(Pg);
      if (!cfg.colaboradorId) return res.status(400).json({ message: 'Defina o colaborador cobrador na configuração antes de fechar.' });

      if (reabrir) {
        await Pg.connectAndQuery(
          `DELETE FROM tab_cobranca_comissao_fechamento WHERE ano_mes = @am AND colaborador_id = @cid`,
          { am: anoMes, cid: cfg.colaboradorId });
        return res.json({ ok: true, reaberto: true });
      }

      const r = await Comissao.apurar({ Protheus, Pg }, anoMes);
      const snapshot = JSON.stringify({
        faixas: r.config.faixas, busExcluidas: r.config.busExcluidas,
        totais: r.totais, detalhe: r.detalhe
      });

      await Pg.connectAndQuery(
        `INSERT INTO tab_cobranca_comissao_fechamento
           (ano_mes, colaborador_id, base_recuperada, comissao, snapshot, fechado_por)
         VALUES (@am, @cid, @base, @com, @snap, @uid)
         ON CONFLICT (ano_mes, colaborador_id) DO UPDATE
            SET base_recuperada = EXCLUDED.base_recuperada,
                comissao        = EXCLUDED.comissao,
                snapshot        = EXCLUDED.snapshot,
                fechado_por     = EXCLUDED.fechado_por,
                fechado_em      = NOW()`,
        { am: anoMes, cid: cfg.colaboradorId, base: r.totais.baseComissionavel,
          com: r.totais.comissao, snap: snapshot, uid: user.ID });

      return res.json({ ok: true, anoMes, base: r.totais.baseComissionavel, comissao: r.totais.comissao });
    } catch (err) {
      console.error('cobranca/comissao-fechar:', err);
      return res.status(500).json({ message: 'Erro ao fechar: ' + err.message });
    }
  }
});

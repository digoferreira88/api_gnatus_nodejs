// GET /cobranca/comissao?anoMes=YYYYMM — apura a comissão do mês (competência =
// mês da baixa). Retorna totais + detalhe título a título + se está fechado. Perm 9006.
const Comissao = require('../../services/cobrancaComissao');
const toN = (v) => Number(v || 0);
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9006, 0]);

module.exports = (app) => ({
  verb: 'get',
  route: '/comissao',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;
    const hoje = new Date();
    const mesAtual = `${hoje.getFullYear()}${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const anoMes = /^\d{6}$/.test(req.query.anoMes) ? String(req.query.anoMes) : mesAtual;

    try {
      const r = await Comissao.apurar({ Protheus, Pg }, anoMes);

      // Fechamento (se houver) do colaborador configurado
      let fechado = null;
      if (r.config.colaboradorId) {
        const fRows = await Pg.connectAndQuery(
          `SELECT f.base_recuperada, f.comissao, f.fechado_em, u.nome AS fechado_por_nome
             FROM tab_cobranca_comissao_fechamento f
             LEFT JOIN tab_intranet_usr u ON u.id = f.fechado_por
            WHERE f.ano_mes = @am AND f.colaborador_id = @cid`,
          { am: anoMes, cid: r.config.colaboradorId });
        if (fRows[0]) fechado = {
          baseRecuperada: toN(fRows[0].base_recuperada),
          comissao: toN(fRows[0].comissao),
          fechadoEm: fRows[0].fechado_em,
          fechadoPor: String(fRows[0].fechado_por_nome || '').trim()
        };
      }

      return res.json({
        anoMes,
        colaborador: r.config.colaboradorId ? { id: r.config.colaboradorId, nome: r.config.colaboradorNome } : null,
        faixas: r.config.faixas,
        busExcluidas: r.config.busExcluidas,
        totais: r.totais,
        detalhe: r.detalhe,
        fechado
      });
    } catch (err) {
      console.error('cobranca/comissao:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// POST /qualificacao/inspecoes/calcular — prévia ao vivo do formulário: amostra (NBR 5426,
// pelo nível), C, P (entrega se nacional, coleta se importado), N, IQF da entrega, entregas
// que formam o N, situação de recebimento do fornecedor (bloqueios), alerta de item crítico e
// o que a média do fornecedor passaria a ser. Não grava nada. Perm 23002+ (Inspetor).

const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');
const I = require('../../services/qfInspecao');

module.exports = (app) => ({
  verb: 'post',
  route: '/inspecoes/calcular',
  middlewares: [Q.mw(app, 'inspetor')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    try {
      const d = I.normalizar(b);
      const inspId = Number(b.id) || null;
      let relInsp = null, herdados = [], atualFornecedor = null;
      if (inspId) {
        const [x] = await Pg.connectAndQuery(`SELECT rel_insp, origem, indice_p, indice_n, fornecedor_id FROM tab_qf_inspecao WHERE id = @id`, { id: inspId });
        if (x) { relInsp = x.rel_insp; atualFornecedor = x.fornecedor_id; herdados = I.herdarDoLegado(x, d); }
      }
      const regra = await Q.regraAtiva(Pg);
      let fornecedor = null, projecao = null, recebimento = null;
      if (d.fornecedorId) {
        const [f] = await Pg.connectAndQuery(
          `SELECT id, codigo, razao_social, status_qualificacao, suspensao_tipo, motivo_suspensao, criticidades, nacional, ativo,
                  iqf_medio, qtd_inspecoes, classificacao, inspecao_100, iqf_desde FROM tab_qf_fornecedor WHERE id = @id`, { id: d.fornecedorId });
        fornecedor = f || null;
        if (f) {
          d.importado = f.nacional === false;
          const niveis = await Q.niveisDoUsuario(Pg, req);
          recebimento = atualFornecedor === f.id ? { permitido: true, correcao: true } : I.situacaoRecebimento(f, niveis);
        }
      }
      const r = await I.calcular(Pg, d, { regra, inspecaoId: inspId, relInsp, fornecedor });
      if (fornecedor && r.calc.iqf != null && R.monitorado(fornecedor)) {
        const [agg] = await Pg.connectAndQuery(
          `SELECT COALESCE(SUM(iqf), 0) soma, COUNT(iqf)::int qtd FROM tab_qf_inspecao WHERE fornecedor_id = @f AND NOT excluido AND iqf IS NOT NULL AND id <> @ex
              AND (@desde::date IS NULL OR data_inspecao >= @desde::date)`,
          { f: fornecedor.id, ex: inspId || 0, desde: fornecedor.iqf_desde || null });
        const media = Q.r4((Number(agg.soma) + r.calc.iqf) / (agg.qtd + 1));
        projecao = { media, qtd: agg.qtd + 1, classe: R.classificar(regra.conteudo, media) };
      }
      const inspecao100 = !!(fornecedor && fornecedor.inspecao_100 && !(recebimento && recebimento.correcao));
      return res.json({
        ...r,
        erros: R.validarInspecao(d, { inspecao100 }),
        herdadosDaPlanilha: herdados,
        fornecedor, recebimento, inspecao100, projecao,
        monitorado: fornecedor ? R.monitorado(fornecedor) : null,
        classeAtual: fornecedor ? R.classificar(regra.conteudo, fornecedor.iqf_medio) : null,
        valoresPermitidos: { C: R.valoresPermitidos(regra.conteudo, 'C'), P: R.valoresPermitidos(regra.conteudo, 'P'), N: R.valoresPermitidos(regra.conteudo, 'N') }
      });
    } catch (err) { return Q.falha(res, 'calcular a inspeção', err); }
  }
});

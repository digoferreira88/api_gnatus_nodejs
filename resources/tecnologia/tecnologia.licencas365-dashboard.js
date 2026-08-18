// GET /tecnologia/licencas365 — dashboard de licenças M365: SKUs ao vivo do
// Graph (subscribedSkus) + valor mensal cadastrado (tab_m365_licenca_custo).
// Perm 1035.
//
// Custos calculados por SKU e no total:
//   custoContratado = total      × valorMensal  (o que a fatura cobra)
//   custoEmUso      = atribuidas × valorMensal
//   custoOcioso     = disponiveis× valorMensal  (licença paga sem usuário)

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1035]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/licencas365',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, M365 } = app.services;
    try {
      const skus = await M365.listSkus();

      const custos = new Map();
      try {
        const rows = await Pg.connectAndQuery(
          `SELECT sku_part_number, valor_mensal, obs, atualizado_por, atualizado_em
             FROM tab_m365_licenca_custo`, {});
        rows.forEach(r => custos.set(trim(r.sku_part_number), {
          valorMensal: N(r.valor_mensal), obs: trim(r.obs) || null,
          por: trim(r.atualizado_por) || null, em: r.atualizado_em
        }));
      } catch (e) { console.warn('licencas365: tab_m365_licenca_custo indisponivel (migration 93?):', e.message); }

      // SKUs gratuitos/trial vêm do Graph com prepaidUnits gigantes (Flow Free =
      // 1.000.000 etc.) e explodiriam os totais ("1 milhão de licenças contratadas").
      // >= 10000 unidades = tratamos como ILIMITADA: aparece na tabela, fica fora
      // dos somatórios.
      const ILIMITADA = 10000;
      const licencas = skus.map(s => {
        const c = custos.get(trim(s.partNumber));
        const valorMensal = c ? c.valorMensal : null;
        return {
          ...s,
          ilimitada: s.total >= ILIMITADA,
          pctUso: s.total > 0 ? +(s.atribuidas / s.total * 100).toFixed(1) : 0,
          valorMensal,
          custoContratado: valorMensal != null ? +(s.total * valorMensal).toFixed(2) : null,
          custoEmUso: valorMensal != null ? +(s.atribuidas * valorMensal).toFixed(2) : null,
          custoOcioso: valorMensal != null ? +(s.disponiveis * valorMensal).toFixed(2) : null,
          custoObs: c ? c.obs : null,
          custoAtualizadoPor: c ? c.por : null,
          custoAtualizadoEm: c ? c.em : null
        };
      }).sort((a, b) => b.atribuidas - a.atribuidas);

      // Totais só com SKUs pagos/limitados (ilimitados distorceriam tudo)
      const pagas = licencas.filter(l => !l.ilimitada);
      const soma = (f) => pagas.reduce((s, l) => s + (f(l) || 0), 0);
      return res.json({
        geradoEm: new Date().toISOString(),
        totais: {
          skus: licencas.length,
          skusIlimitadas: licencas.length - pagas.length,
          licencasTotal: soma(l => l.total),
          licencasAtribuidas: soma(l => l.atribuidas),
          licencasDisponiveis: soma(l => l.disponiveis),
          // Custos consideram só SKUs pagos com valor cadastrado
          skusComValor: pagas.filter(l => l.valorMensal != null).length,
          custoContratado: +soma(l => l.custoContratado).toFixed(2),
          custoEmUso: +soma(l => l.custoEmUso).toFixed(2),
          custoOcioso: +soma(l => l.custoOcioso).toFixed(2)
        },
        licencas
      });
    } catch (err) {
      console.error('tecnologia/licencas365-dashboard:', err);
      return res.status(502).json({ message: 'Falha ao consultar o Microsoft 365: ' + err.message });
    }
  }
});

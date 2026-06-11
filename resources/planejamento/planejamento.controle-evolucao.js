// GET /planejamento/controle/evolucao?mes=YYYYMM
// Série diária de faturamento (real, SD2 por emissão da NF) x meta diária, com
// acumulados — alimenta o gráfico de gestão à vista. Permissão 3003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([3003]);
const { getCfops, inLista } = require('../vendas/_cfops');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

module.exports = (app) => ({
  verb: 'get',
  route: '/controle/evolucao',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const hoje = new Date();
    const mes = /^\d{6}$/.test(trim(req.query.mes)) ? trim(req.query.mes) : `${hoje.getFullYear()}${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const ano = +mes.slice(0, 4), mm = +mes.slice(4, 6);
    const ultimoDia = new Date(ano, mm, 0).getDate();
    const inicioMes = `${mes}01`;
    const fimMes = ymd(new Date(ano, mm, 0));
    const hojeYmd = ymd(hoje);

    try {
      const metaRow = (await Pg.connectAndQuery(`SELECT meta_mensal, dias_uteis FROM tab_plan_meta WHERE mes=@mes`, { mes }))[0] || { meta_mensal: 0, dias_uteis: 21 };
      const metaMensal = N(metaRow.meta_mensal), diasUteis = N(metaRow.dias_uteis) || 21;
      const metaDiaria = r2(metaMensal / diasUteis);

      // Faturamento por dia (NF emitida)
      const fatMap = new Map();
      const cfops = await getCfops(Pg, 'faturamento');
      if (cfops.length) {
        const rows = await Protheus.connectAndQuery(`
          SELECT RTRIM(sd2.D2_EMISSAO) dia, SUM(sd2.D2_VALBRUT - ISNULL(sd2.D2_VALDEV,0)) valor
            FROM SD2010 sd2 WITH (NOLOCK)
           WHERE sd2.D_E_L_E_T_<>'*' AND sd2.D2_FILIAL='01'
             AND sd2.D2_EMISSAO BETWEEN @ini AND @fim AND RTRIM(sd2.D2_CF) IN (${inLista(cfops)})
           GROUP BY sd2.D2_EMISSAO`, { ini: inicioMes, fim: fimMes });
        rows.forEach(r => fatMap.set(trim(r.dia), N(r.valor)));
      }

      // Monta série dia-a-dia
      const dias = [];
      let fatAcum = 0, metaAcum = 0;
      const mesPassou = fimMes < hojeYmd;
      for (let d = 1; d <= ultimoDia; d++) {
        const date = new Date(ano, mm - 1, d);
        const dy = ymd(date);
        const util = date.getDay() >= 1 && date.getDay() <= 5;
        const futuro = !mesPassou && dy > hojeYmd;
        const metaDia = util ? metaDiaria : 0;
        metaAcum = Math.min(metaMensal, r2(metaAcum + metaDia));
        let faturado = null, faturadoAcum = null;
        if (!futuro) {
          faturado = r2(fatMap.get(dy) || 0);
          fatAcum = r2(fatAcum + faturado);
          faturadoAcum = fatAcum;
        }
        dias.push({
          dia: dy, diaLabel: `${String(d).padStart(2, '0')}/${String(mm).padStart(2, '0')}`,
          util, futuro, faturado, metaDia: r2(metaDia), faturadoAcum, metaAcum
        });
      }

      return res.json({
        mes, metaMensal, metaDiaria, diasUteis,
        faturadoMes: r2(fatAcum),
        dias, geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro controle/evolucao:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

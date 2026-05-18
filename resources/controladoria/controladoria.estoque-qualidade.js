// GET /controladoria/estoque-qualidade?tipo=PA&armazem=01&criticidade=ruptura
//
// Avalia a qualidade do estoque por produto:
//   - consumo_lead_time   = demanda_media * (lead_time / 30)
//   - estoque_seguranca   = z * desvio_padrao * sqrt(lead_time / 30)
//   - estoque_ideal       = consumo_lead_time + estoque_seguranca
//   - excesso             = max(0, qtd_atual - estoque_ideal)
//   - criticidade: ruptura (qtd=0) | risco (qtd<seguranca) | ideal | excesso
//
// Le snapshot PG (saldo + saidas dos ultimos N meses) e cruza com B1_PE do
// Protheus pra obter lead time real por produto (fallback nos parametros do PG).
//
// Permissao 11004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11004]);
const Calc = require('../../services/estoqueCalculo');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/estoque-qualidade',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const tipo = trim(req.query.tipo);
    const armazem = trim(req.query.armazem);
    const criticidade = trim(req.query.criticidade);  // ruptura|risco|excesso|ideal (opcional)
    const anoMesCorr = Calc.anoMesCorrente();

    try {
      // 1) Parametros: global + por tipo (vamos resolver fallback no JS)
      const paramRows = await Pg.connectAndQuery(
        `SELECT tipo_produto, lead_time_dias, nivel_servico, janela_demanda_meses
           FROM tab_estoque_parametros`,
        {}
      );
      const paramGlobal = paramRows.find(p => !p.tipo_produto) || { lead_time_dias: 30, nivel_servico: 1.65, janela_demanda_meses: 6 };
      const paramPorTipo = new Map();
      paramRows.filter(p => p.tipo_produto).forEach(p => paramPorTipo.set(trim(p.tipo_produto), p));

      const janelaMeses = Number(paramGlobal.janela_demanda_meses) || 6;

      // 2) Snapshot do mes corrente + saidas da janela
      // Agrega por produto somando armazens (ou filtra por armazem)
      const condArm = armazem ? 'AND armazem = @armazem' : '';
      const condTipo = tipo ? 'AND tipo_produto = @tipo' : '';
      const paramsBase = {};
      if (armazem) paramsBase.armazem = armazem;
      if (tipo)    paramsBase.tipo    = tipo;

      const saldoAtual = await Pg.connectAndQuery(`
        SELECT cod_produto,
               MAX(descricao)     descricao,
               MAX(tipo_produto)  tipo_produto,
               MAX(grupo)         grupo,
               SUM(qtd_estoque)   qtd_atual,
               SUM(valor_estoque) valor_atual,
               AVG(custo_medio)   custo_medio
          FROM tab_estoque_snapshot_mensal
         WHERE ano_mes = @anoMes ${condTipo} ${condArm}
         GROUP BY cod_produto`,
        { ...paramsBase, anoMes: anoMesCorr }
      );

      if (saldoAtual.length === 0) {
        return res.json({
          vazio: true, mensagem: 'Sem dados no snapshot. Rode o bootstrap em /controladoria/estoque-valor.',
          anoMes: anoMesCorr, kpis: {}, heatmap: [], produtos: [], param: paramGlobal
        });
      }

      // Saidas mensais por produto na janela (pra calcular media + desvio)
      const anosMesJanela = Calc.ultimosAnoMes(janelaMeses);
      const inAnosMes = anosMesJanela.map((_, i) => `@m${i}`).join(',');
      const paramsSaidas = { ...paramsBase };
      anosMesJanela.forEach((am, i) => { paramsSaidas[`m${i}`] = am; });

      const saidasJanela = await Pg.connectAndQuery(`
        SELECT cod_produto, ano_mes, SUM(qtd_saidas_mes) qtd_saidas
          FROM tab_estoque_snapshot_mensal
         WHERE ano_mes IN (${inAnosMes}) ${condTipo} ${condArm}
         GROUP BY cod_produto, ano_mes`,
        paramsSaidas
      );
      // Mapa cod -> [qtd por mes] (preenche zeros pra meses sem saida)
      const saidasPorCod = new Map();
      saidasJanela.forEach(r => {
        const cod = trim(r.cod_produto);
        if (!saidasPorCod.has(cod)) saidasPorCod.set(cod, new Map());
        saidasPorCod.get(cod).set(r.ano_mes, N(r.qtd_saidas));
      });

      // 3) Lead time + overrides manuais — vem do cache PG (tab_estoque_produto_meta).
      // Override manual (lead_time_override / demanda_mensal_manual / estoque_seguranca_manual)
      // tem prioridade sobre o calculo automatico.
      const metaRows = await Pg.connectAndQuery(`
        SELECT cod_produto, lead_time_dias, lead_time_override,
               demanda_mensal_manual, estoque_seguranca_manual
          FROM tab_estoque_produto_meta`, {}
      );
      const metaProd = new Map();
      metaRows.forEach(r => metaProd.set(trim(r.cod_produto), {
        leadTimeB1: N(r.lead_time_dias),
        leadTimeOver: r.lead_time_override != null ? N(r.lead_time_override) : null,
        demandaManual: r.demanda_mensal_manual != null ? N(r.demanda_mensal_manual) : null,
        segurancaManual: r.estoque_seguranca_manual != null ? N(r.estoque_seguranca_manual) : null
      }));

      // 4) Calcula metricas por produto
      const produtos = saldoAtual.map(s => {
        const cod = trim(s.cod_produto);
        const tipoProd = trim(s.tipo_produto);
        const par = paramPorTipo.get(tipoProd) || paramGlobal;
        const z = N(par.nivel_servico);
        const meta = metaProd.get(cod) || { leadTimeB1: 0, leadTimeOver: null, demandaManual: null, segurancaManual: null };

        // Lead time: override manual > B1_PE > parametro do tipo
        let leadTime, leadTimeFonte;
        if (meta.leadTimeOver != null) { leadTime = meta.leadTimeOver; leadTimeFonte = 'manual'; }
        else if (meta.leadTimeB1 > 0)  { leadTime = meta.leadTimeB1;   leadTimeFonte = 'B1_PE'; }
        else                            { leadTime = N(par.lead_time_dias); leadTimeFonte = 'parametro'; }

        // Demanda historica calculada (sempre, pra mostrar comparativo)
        const mapaSaidas = saidasPorCod.get(cod);
        const arrDemanda = anosMesJanela.map(am => mapaSaidas ? (mapaSaidas.get(am) || 0) : 0);
        const { media: mediaCalc, desvioPadrao } = Calc.estatisticasDemanda(arrDemanda);

        // Demanda usada nos calculos: manual > calculada
        const media = meta.demandaManual != null ? meta.demandaManual : mediaCalc;
        const demandaFonte = meta.demandaManual != null ? 'manual' : 'calculada';

        // Estoque seguranca: manual > formula z*sigma*sqrt(lt)
        const { consumoLeadTime, estoqueSeguranca: segCalc, estoqueIdeal: idealCalc } = Calc.calcularSegurancaEIdeal({
          demandaMedia: media, desvioPadrao, leadTimeDias: leadTime, z
        });
        const estoqueSeguranca = meta.segurancaManual != null ? meta.segurancaManual : segCalc;
        const segurancaFonte = meta.segurancaManual != null ? 'manual' : 'calculada';
        const estoqueIdeal = meta.segurancaManual != null ? (consumoLeadTime + meta.segurancaManual) : idealCalc;

        const qtdAtual = N(s.qtd_atual);
        const cm = N(s.custo_medio);
        const crit = Calc.classificarCriticidade({ qtdAtual, estoqueSeguranca, estoqueIdeal });
        const excessoQtd = Math.max(0, qtdAtual - estoqueIdeal);
        const faltanteQtd = Math.max(0, estoqueSeguranca - qtdAtual);

        return {
          cod_produto: cod,
          descricao: trim(s.descricao),
          tipo: tipoProd,
          grupo: trim(s.grupo),
          qtd_atual: qtdAtual,
          valor_atual: N(s.valor_atual),
          custo_medio: cm,
          lead_time_dias: leadTime,
          lead_time_fonte: leadTimeFonte,
          demanda_media: media,
          demanda_fonte: demandaFonte,
          desvio_padrao: desvioPadrao,
          consumo_lead_time: consumoLeadTime,
          estoque_seguranca: estoqueSeguranca,
          estoque_seguranca_fonte: segurancaFonte,
          estoque_ideal: estoqueIdeal,
          excesso_qtd: Number(excessoQtd.toFixed(2)),
          excesso_valor: Number((excessoQtd * cm).toFixed(2)),
          faltante_qtd: Number(faltanteQtd.toFixed(2)),
          faltante_valor: Number((faltanteQtd * cm).toFixed(2)),
          criticidade: crit,
          nivel_servico: z
        };
      });

      // 5) Filtro de criticidade (aplica depois pra que KPIs reflitam universo total)
      const universo = produtos;
      const listaFiltrada = criticidade
        ? universo.filter(p => p.criticidade === criticidade)
        : universo;

      // 6) KPIs
      const kpis = {
        total_produtos: universo.length,
        ruptura: universo.filter(p => p.criticidade === 'ruptura').length,
        risco: universo.filter(p => p.criticidade === 'risco').length,
        ideal: universo.filter(p => p.criticidade === 'ideal').length,
        excesso: universo.filter(p => p.criticidade === 'excesso').length,
        valor_excesso: Number(universo.reduce((s, p) => s + p.excesso_valor, 0).toFixed(2)),
        valor_total_estoque: Number(universo.reduce((s, p) => s + p.valor_atual, 0).toFixed(2)),
        pct_cobertura_ideal: universo.length > 0
          ? Number(((universo.filter(p => p.criticidade === 'ideal').length / universo.length) * 100).toFixed(2))
          : 0
      };

      // 7) Heatmap: tipo × criticidade (qtd de produtos + valor)
      const heatmapMap = new Map();
      const tiposSet = new Set();
      universo.forEach(p => {
        const key = `${p.tipo}|${p.criticidade}`;
        if (!heatmapMap.has(key)) heatmapMap.set(key, { tipo: p.tipo, criticidade: p.criticidade, qtd: 0, valor: 0 });
        const h = heatmapMap.get(key);
        h.qtd += 1;
        h.valor += p.valor_atual;
        tiposSet.add(p.tipo);
      });
      const heatmap = [...heatmapMap.values()].map(h => ({
        ...h, valor: Number(h.valor.toFixed(2))
      }));

      // 8) Valor R$ em excesso por tipo (pra grafico de barras)
      const excessoPorTipoMap = new Map();
      universo.forEach(p => {
        if (p.excesso_valor > 0) {
          excessoPorTipoMap.set(p.tipo, (excessoPorTipoMap.get(p.tipo) || 0) + p.excesso_valor);
        }
      });
      const excesso_por_tipo = [...excessoPorTipoMap.entries()]
        .map(([tipo, valor]) => ({ tipo, valor: Number(valor.toFixed(2)) }))
        .sort((a, b) => b.valor - a.valor);

      // 9) Ranking de criticos: ruptura + risco, ordenado por valor (impacto)
      const criticos = universo
        .filter(p => p.criticidade === 'ruptura' || p.criticidade === 'risco')
        .sort((a, b) => b.valor_atual - a.valor_atual || b.faltante_valor - a.faltante_valor)
        .slice(0, 100);

      return res.json({
        vazio: false,
        anoMes: anoMesCorr,
        filtros: { tipo, armazem, criticidade },
        param_aplicado: {
          janela_meses: janelaMeses,
          z_global: N(paramGlobal.nivel_servico),
          lead_time_global: N(paramGlobal.lead_time_dias),
          override_por_tipo: paramRows.filter(p => p.tipo_produto).map(p => ({
            tipo: trim(p.tipo_produto),
            lead_time: N(p.lead_time_dias),
            z: N(p.nivel_servico),
            janela: N(p.janela_demanda_meses)
          }))
        },
        kpis,
        heatmap,
        tipos: [...tiposSet].sort(),
        excesso_por_tipo,
        criticos,
        lista: listaFiltrada
          .sort((a, b) => {
            // Ordem: ruptura > risco > excesso > ideal; dentro de cada, maior valor primeiro
            const ord = { ruptura: 0, risco: 1, excesso: 2, ideal: 3 };
            return (ord[a.criticidade] - ord[b.criticidade]) || (b.valor_atual - a.valor_atual);
          })
          .slice(0, 500),
        gerado_em: new Date().toISOString()
      });
    } catch (err) {
      console.error('estoque-qualidade:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

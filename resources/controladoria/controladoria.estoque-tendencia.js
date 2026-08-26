// GET /controladoria/estoque-tendencia?tipo=PA&armazem=01&janela=6
//
// Projeta tendencia de crescimento/reducao do estoque comparando:
//   - Pedidos colocados (SC7 compras + SC2 ordens de producao) por mes (emissao)
//   - Recebimentos previstos (SC7 cuja data prevista de entrega cai no mes)
//   - Consumo medio (saidas do snapshot: SD2 vendas + SD3 producao)
//
// Regra:
//   ratio = pedidos / consumo
//   ratio > 1.1 -> AUMENTO
//   ratio < 0.9 -> REDUCAO
//   senao        -> NEUTRO
//
// Projeta 3 meses a frente via regressao linear simples sobre o consumo.
// Lista os top produtos com risco de overstock (pedido futuro alto + consumo
// baixo) e os top com risco de ruptura (consumo alto + sem pedido em aberto).
//
// Permissao 11004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11004]);
const Calc = require('../../services/estoqueCalculo');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

// CFOPs ja usados em outros endpoints; mantemos sd2 vendas via snapshot.
// Pedidos colocados = SC7 (compras). C7_RESIDUO != 'S' (nao bloqueados).
// Para producao, usamos SC2 (ordem de producao) com data emissao.

module.exports = (app) => ({
  verb: 'get',
  route: '/estoque-tendencia',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const tipo    = trim(req.query.tipo);
    const armazem = trim(req.query.armazem);
    const janela  = Math.min(Math.max(Number(req.query.janela) || 6, 3), 12);

    const anosMes = Calc.ultimosAnoMes(janela).reverse();  // mais antigo -> mais novo
    const ymdIni  = `${anosMes[0]}01`;
    // Ultimo dia do ultimo mes da janela
    const anoMesFim = anosMes[anosMes.length - 1];
    const ultimoDia = new Date(Number(anoMesFim.slice(0, 4)), Number(anoMesFim.slice(4, 6)), 0).getDate();
    const ymdFim  = `${anoMesFim}${String(ultimoDia).padStart(2, '0')}`;

    try {
      // Refresca o mês corrente (estoque de agora, não a foto das 03:00) antes de ler.
      // Rápido + guarda de frescor; meses passados intactos. Falha = segue com a foto.
      try { await require('../../services/estoqueSnapshot').refrescarMesCorrente(app, { maxIdadeMin: 10 }); }
      catch (e) { console.warn('estoque-tendencia: refresh mes corrente falhou:', e.message); }

      // 1) Snapshot: consumo + saldo por produto na janela
      const condTipo = tipo ? 'AND tipo_produto = @tipo' : '';
      const condArm  = armazem ? 'AND armazem = @armazem' : '';
      const inAnosMes = anosMes.map((_, i) => `@m${i}`).join(',');
      const paramsSnap = {};
      if (tipo)    paramsSnap.tipo    = tipo;
      if (armazem) paramsSnap.armazem = armazem;
      anosMes.forEach((am, i) => { paramsSnap[`m${i}`] = am; });

      const serieConsumo = await Pg.connectAndQuery(`
        SELECT ano_mes,
               SUM(valor_saidas_mes) valor_saidas,
               SUM(qtd_saidas_mes)   qtd_saidas
          FROM tab_estoque_snapshot_mensal
         WHERE ano_mes IN (${inAnosMes}) ${condTipo} ${condArm}
         GROUP BY ano_mes
         ORDER BY ano_mes`,
        paramsSnap
      );

      // Saldo atual (ultimo mes do snapshot)
      const anoMesCorr = Calc.anoMesCorrente();
      const saldoRows = await Pg.connectAndQuery(`
        SELECT SUM(qtd_estoque) qtd, SUM(valor_estoque) valor
          FROM tab_estoque_snapshot_mensal
         WHERE ano_mes = @anoMes ${condTipo} ${condArm}`,
        { ...paramsSnap, anoMes: anoMesCorr }
      );
      const saldoAtual = N(saldoRows[0]?.valor);

      // 2) Pedidos colocados (SC7) por mes — emissao no periodo
      // Aplica filtro de tipo via JOIN com SB1, e armazem via C7_LOCAL.
      const filtroTipoSC7 = tipo
        ? `INNER JOIN SB1010 sb1 WITH (NOLOCK)
             ON sb1.B1_COD = sc7.C7_PRODUTO AND sb1.D_E_L_E_T_ <> '*'
             AND RTRIM(sb1.B1_TIPO) = @tipo`
        : '';
      const filtroArmSC7 = armazem ? `AND RTRIM(sc7.C7_LOCAL) = @armazem` : '';

      const paramsSC7 = { ini: ymdIni, fim: ymdFim };
      if (tipo)    paramsSC7.tipo    = tipo;
      if (armazem) paramsSC7.armazem = armazem;

      const pedidosColocados = await Protheus.connectAndQuery(`
        SELECT SUBSTRING(sc7.C7_EMISSAO, 1, 6) ano_mes,
               SUM(sc7.C7_TOTAL) valor,
               SUM(sc7.C7_QUANT) qtd
          FROM SC7010 sc7 WITH (NOLOCK)
          ${filtroTipoSC7}
         WHERE sc7.D_E_L_E_T_ <> '*'
           AND sc7.C7_FILIAL = '01'
           AND sc7.C7_EMISSAO BETWEEN @ini AND @fim
           AND RTRIM(sc7.C7_RESIDUO) <> 'S'
           ${filtroArmSC7}
         GROUP BY SUBSTRING(sc7.C7_EMISSAO, 1, 6)
         ORDER BY ano_mes`,
        paramsSC7
      );

      // 3) Recebimentos previstos (SC7 com data prevista no periodo, ainda em aberto)
      const recebimentosPrevistos = await Protheus.connectAndQuery(`
        SELECT SUBSTRING(sc7.C7_DATPRF, 1, 6) ano_mes,
               SUM(sc7.C7_TOTAL * (1 - (sc7.C7_QUJE * 1.0 / NULLIF(sc7.C7_QUANT, 0)))) valor_pendente,
               SUM(sc7.C7_QUANT - sc7.C7_QUJE) qtd_pendente
          FROM SC7010 sc7 WITH (NOLOCK)
          ${filtroTipoSC7}
         WHERE sc7.D_E_L_E_T_ <> '*'
           AND sc7.C7_FILIAL = '01'
           AND sc7.C7_DATPRF BETWEEN @ini AND @fim
           AND RTRIM(sc7.C7_RESIDUO) <> 'S'
           AND sc7.C7_QUANT > sc7.C7_QUJE
           ${filtroArmSC7}
         GROUP BY SUBSTRING(sc7.C7_DATPRF, 1, 6)
         ORDER BY ano_mes`,
        paramsSC7
      );

      // 4) Ordens de Producao (SC2) — para PA significa entrada, para MP saida
      // Aqui contamos como "pedido colocado" do PA (entrada futura).
      const filtroTipoSC2 = tipo
        ? `INNER JOIN SB1010 sb1c2 WITH (NOLOCK)
             ON sb1c2.B1_COD = sc2.C2_PRODUTO AND sb1c2.D_E_L_E_T_ <> '*'
             AND RTRIM(sb1c2.B1_TIPO) = @tipo`
        : '';
      const filtroArmSC2 = armazem ? `AND RTRIM(sc2.C2_LOCAL) = @armazem` : '';

      const ordensProd = await Protheus.connectAndQuery(`
        SELECT SUBSTRING(sc2.C2_EMISSAO, 1, 6) ano_mes,
               SUM(sc2.C2_QUANT) qtd,
               SUM(sc2.C2_QUANT * ISNULL(sb1q.B1_CUSTD, 0)) valor
          FROM SC2010 sc2 WITH (NOLOCK)
          LEFT JOIN SB1010 sb1q WITH (NOLOCK)
            ON sb1q.B1_COD = sc2.C2_PRODUTO AND sb1q.D_E_L_E_T_ <> '*'
          ${filtroTipoSC2}
         WHERE sc2.D_E_L_E_T_ <> '*'
           AND sc2.C2_FILIAL = '01'
           AND sc2.C2_EMISSAO BETWEEN @ini AND @fim
           ${filtroArmSC2}
         GROUP BY SUBSTRING(sc2.C2_EMISSAO, 1, 6)
         ORDER BY ano_mes`,
        paramsSC7
      ).catch(err => {
        // SC2 pode falhar se a tabela tem schema diferente em algumas instalacoes;
        // tendencia funciona mesmo sem SC2.
        console.warn('estoque-tendencia: SC2 falhou, ignorando:', err.message);
        return [];
      });

      // 5) Monta serie unificada (12 meses × 3 series + projecao 3 meses)
      const mapConsumo = new Map(serieConsumo.map(r => [r.ano_mes, N(r.valor_saidas)]));
      const mapPedidos = new Map(pedidosColocados.map(r => [trim(r.ano_mes), N(r.valor)]));
      const mapRecebPrev = new Map(recebimentosPrevistos.map(r => [trim(r.ano_mes), N(r.valor_pendente)]));
      const mapOP = new Map(ordensProd.map(r => [trim(r.ano_mes), N(r.valor)]));

      // serie:
      //   pedidos_colocados = SO compras SC7 (sem misturar com SC2 OP — corrige
      //                       inflacao de jun em diante reportada pela operacao)
      //   ordens_producao   = SC2 separado, exibido como info adicional
      //   consumo           = SD2 vendas (CMV) + SD3 producao (D3_CUSTO1)
      //   delta             = pedidos_colocados - consumo
      const serie = anosMes.map(am => {
        const consumo = mapConsumo.get(am) || 0;
        const pedidos = mapPedidos.get(am) || 0;
        const opValor = mapOP.get(am) || 0;
        const receb   = mapRecebPrev.get(am) || 0;
        const delta   = pedidos - consumo;
        return {
          ano_mes: am,
          consumo: Number(consumo.toFixed(2)),
          pedidos_colocados: Number(pedidos.toFixed(2)),
          ordens_producao: Number(opValor.toFixed(2)),
          recebimentos_previstos: Number(receb.toFixed(2)),
          delta: Number(delta.toFixed(2))
        };
      });

      // Medias da janela — exibidas como linha horizontal no grafico do front
      // pra validar tendencia (ratio = mediaPedidos / mediaConsumo).
      const medConsumo = serie.reduce((s, r) => s + r.consumo, 0) / Math.max(serie.length, 1);
      const medPedidos = serie.reduce((s, r) => s + r.pedidos_colocados, 0) / Math.max(serie.length, 1);

      // 6) Projecao 3 meses a frente — regressao linear do consumo
      // Pra entradas, projetamos com base nos recebimentos previstos ja conhecidos
      // (SC7 com C7_DATPRF futura). O backend ja capturou tudo na janela; pra
      // projecao alem da janela, repetimos a media dos ultimos 3 meses.
      const consumoArr  = serie.map(s => s.consumo);
      const projConsumo = Calc.projecaoLinear(consumoArr, 3);

      // Projecao usa media dos ULTIMOS 3 meses (mais responsiva a mudanca recente)
      const ultimos3Pedidos = serie.slice(-3).map(s => s.pedidos_colocados);
      const mediaPedidosUlt3 = ultimos3Pedidos.length > 0
        ? ultimos3Pedidos.reduce((s, v) => s + v, 0) / ultimos3Pedidos.length
        : 0;
      const projPedidos = Array(3).fill(Number(mediaPedidosUlt3.toFixed(2)));

      // Anos-mes projetados
      const projAnosMes = [];
      let dProj = new Date(Number(anoMesFim.slice(0, 4)), Number(anoMesFim.slice(4, 6)) - 1, 1);
      for (let i = 0; i < 3; i++) {
        dProj.setMonth(dProj.getMonth() + 1);
        projAnosMes.push(`${dProj.getFullYear()}${String(dProj.getMonth() + 1).padStart(2, '0')}`);
      }

      const projecao = projAnosMes.map((am, i) => ({
        ano_mes: am,
        consumo_proj: projConsumo[i],
        pedidos_proj: projPedidos[i],
        delta_proj: Number((projPedidos[i] - projConsumo[i]).toFixed(2))
      }));

      // Saldo projetado: acumula delta sobre saldo atual
      let saldoProj = saldoAtual;
      const saldoProjetado = projecao.map(p => {
        saldoProj += p.delta_proj;
        return { ano_mes: p.ano_mes, saldo_projetado: Number(saldoProj.toFixed(2)) };
      });

      // 7) KPIs / Tendencia geral
      const ultPedidos = serie[serie.length - 1]?.pedidos_colocados || 0;
      const ultConsumo = serie[serie.length - 1]?.consumo || 0;
      const ultReceb   = serie[serie.length - 1]?.recebimentos_previstos || 0;
      const tend = Calc.classificarTendencia(medConsumo, medPedidos);

      const kpis = {
        pedidos_colocados_mes_atual: Number(ultPedidos.toFixed(2)),
        recebimento_previsto_mes_atual: Number(ultReceb.toFixed(2)),
        consumo_mes_atual: Number(ultConsumo.toFixed(2)),
        consumo_medio_janela: Number(medConsumo.toFixed(2)),
        pedidos_medio_janela: Number(medPedidos.toFixed(2)),
        saldo_atual: Number(saldoAtual.toFixed(2)),
        tendencia: tend.tendencia,                // 'aumento' | 'reducao' | 'neutro'
        tendencia_ratio: tend.ratio,
        delta_mensal_medio: Number((medPedidos - medConsumo).toFixed(2))
      };

      // 8) Top produtos com risco de overstock futuro
      // Critério: produto com pedido em aberto significativo + consumo baixo
      const overstockTop = await Protheus.connectAndQuery(`
        SELECT TOP 30
               RTRIM(sc7.C7_PRODUTO) cod_produto,
               RTRIM(sb1.B1_DESC)    descricao,
               RTRIM(sb1.B1_TIPO)    tipo_produto,
               SUM(sc7.C7_QUANT - sc7.C7_QUJE)               qtd_pendente,
               SUM((sc7.C7_QUANT - sc7.C7_QUJE) * sc7.C7_PRECO) valor_pendente
          FROM SC7010 sc7 WITH (NOLOCK)
          INNER JOIN SB1010 sb1 WITH (NOLOCK)
            ON sb1.B1_COD = sc7.C7_PRODUTO AND sb1.D_E_L_E_T_ <> '*'
            ${tipo ? "AND RTRIM(sb1.B1_TIPO) = @tipo" : ''}
         WHERE sc7.D_E_L_E_T_ <> '*'
           AND sc7.C7_FILIAL = '01'
           AND RTRIM(sc7.C7_RESIDUO) <> 'S'
           AND sc7.C7_QUANT > sc7.C7_QUJE
           ${filtroArmSC7}
         GROUP BY sc7.C7_PRODUTO, sb1.B1_DESC, sb1.B1_TIPO
         ORDER BY SUM((sc7.C7_QUANT - sc7.C7_QUJE) * sc7.C7_PRECO) DESC`,
        paramsSC7
      );

      // Enriquece com consumo medio na janela (PG)
      const codsOver = overstockTop.map(o => trim(o.cod_produto));
      const consumoPorCod = new Map();
      if (codsOver.length > 0) {
        const inCods = codsOver.map((_, i) => `@c${i}`).join(',');
        const pCons = {};
        codsOver.forEach((c, i) => { pCons[`c${i}`] = c; });
        anosMes.forEach((am, i) => { pCons[`m${i}`] = am; });
        const consRows = await Pg.connectAndQuery(`
          SELECT cod_produto, SUM(qtd_saidas_mes) qtd_saidas, SUM(valor_saidas_mes) valor_saidas
            FROM tab_estoque_snapshot_mensal
           WHERE cod_produto IN (${inCods})
             AND ano_mes IN (${inAnosMes})
           GROUP BY cod_produto`, pCons);
        consRows.forEach(r => consumoPorCod.set(trim(r.cod_produto), {
          qtd: N(r.qtd_saidas), valor: N(r.valor_saidas)
        }));
      }

      const overstock = overstockTop.map(o => {
        const cod = trim(o.cod_produto);
        const cons = consumoPorCod.get(cod) || { qtd: 0, valor: 0 };
        const consumoMensal = cons.qtd / janela;
        const mesesParaConsumir = consumoMensal > 0 ? N(o.qtd_pendente) / consumoMensal : 999;
        return {
          cod_produto: cod,
          descricao: trim(o.descricao),
          tipo: trim(o.tipo_produto),
          qtd_pendente: N(o.qtd_pendente),
          valor_pendente: N(o.valor_pendente),
          consumo_mensal: Number(consumoMensal.toFixed(2)),
          meses_para_consumir: Number(mesesParaConsumir.toFixed(1)),
          risco_overstock: mesesParaConsumir > 6
        };
      }).filter(o => o.risco_overstock).slice(0, 15);

      return res.json({
        vazio: serie.every(s => s.consumo === 0 && s.pedidos_colocados === 0),
        anoMes: anoMesCorr,
        janela_meses: janela,
        filtros: { tipo, armazem, janela },
        kpis,
        serie,
        projecao,
        saldo_projetado: saldoProjetado,
        overstock,
        gerado_em: new Date().toISOString()
      });
    } catch (err) {
      console.error('estoque-tendencia:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

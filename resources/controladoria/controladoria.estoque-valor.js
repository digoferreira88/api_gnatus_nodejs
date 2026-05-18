// GET /controladoria/estoque-valor?anoMes=YYYYMM&tipo=PA&armazem=01&semGiroMeses=6
//
// Retorna o dashboard de Estoque -> Valor:
//   - KPIs do mes corrente (filtrado): valor total, qtd itens, giro anual,
//     cobertura em dias, delta vs mes anterior
//   - serie 12m (valor + giro mensal) pro grafico ComposedChart
//   - curva ABC sobre os produtos do mes corrente
//   - top "sem giro" (sem saidas ha N meses)
//   - top curva A com baixo giro (alto valor + giro abaixo da mediana do tipo)
//
// Le do snapshot PG (tab_estoque_snapshot_mensal). Se vazio, retorna { vazio: true }
// pro frontend mostrar mensagem "rodar snapshot inicial".
//
// Permissao 11004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11004]);
const Calc = require('../../services/estoqueCalculo');

module.exports = (app) => ({
  verb: 'get',
  route: '/estoque-valor',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const anoMes = String(req.query.anoMes || Calc.anoMesCorrente());
    const tipo = String(req.query.tipo || '').trim();
    const armazem = String(req.query.armazem || '').trim();
    const semGiroMeses = Math.min(Math.max(Number(req.query.semGiroMeses) || 6, 1), 24);

    if (!/^\d{6}$/.test(anoMes)) {
      return res.status(400).json({ message: 'anoMes invalido (formato YYYYMM).' });
    }

    const condsBase = ['1=1'];
    const params = { anoMes };
    if (tipo)    { condsBase.push('tipo_produto = @tipo');   params.tipo = tipo; }
    if (armazem) { condsBase.push('armazem = @armazem');     params.armazem = armazem; }
    const where = condsBase.join(' AND ');

    try {
      // 1) Mes corrente do filtro: agregado por produto (somando armazens caso filtro vazio)
      const itensMes = await Pg.connectAndQuery(`
        SELECT cod_produto, MAX(descricao) descricao, MAX(tipo_produto) tipo_produto,
               MAX(grupo) grupo,
               SUM(qtd_estoque)     qtd_estoque,
               SUM(valor_estoque)   valor_estoque,
               SUM(qtd_saidas_mes)  qtd_saidas,
               SUM(valor_saidas_mes) valor_saidas
          FROM tab_estoque_snapshot_mensal
         WHERE ano_mes = @anoMes ${tipo ? 'AND tipo_produto = @tipo' : ''} ${armazem ? 'AND armazem = @armazem' : ''}
         GROUP BY cod_produto
         ORDER BY SUM(valor_estoque) DESC`,
        params
      );

      if (itensMes.length === 0) {
        // checa se ha qualquer dado no snapshot pra orientar o frontend
        const total = await Pg.connectAndQuery(`SELECT COUNT(*) c FROM tab_estoque_snapshot_mensal`, {});
        if (Number(total[0]?.c || 0) === 0) {
          return res.json({ vazio: true, mensagem: 'Snapshot nao foi inicializado. Rode POST /controladoria/estoque-snapshot-rodar?meses=12.' });
        }
        // Tem dados mas o filtro nao retorna nada
        return res.json({
          vazio: false,
          anoMes,
          filtros: { tipo, armazem, semGiroMeses },
          kpis: { valor_total: 0, valor_anterior: 0, delta_pct: 0, qtd_itens: 0, giro_anual: 0, cobertura_dias: null },
          serie_12m: [], abc: [], sem_giro: [], curva_a_baixo_giro: [],
          totais_por_tipo: [], totais_por_armazem: []
        });
      }

      // 2) Serie 12m (apenas filtros tipo/armazem, anoMes varia)
      const condsSerie = ['1=1'];
      const paramsSerie = {};
      if (tipo)    { condsSerie.push('tipo_produto = @tipo');   paramsSerie.tipo = tipo; }
      if (armazem) { condsSerie.push('armazem = @armazem');     paramsSerie.armazem = armazem; }

      const serieRows = await Pg.connectAndQuery(`
        SELECT ano_mes,
               SUM(valor_estoque)     valor_estoque,
               SUM(qtd_estoque)       qtd_estoque,
               SUM(valor_saidas_mes)  valor_saidas,
               SUM(qtd_saidas_mes)    qtd_saidas
          FROM tab_estoque_snapshot_mensal
         WHERE ${condsSerie.join(' AND ')}
         GROUP BY ano_mes
         ORDER BY ano_mes`,
        paramsSerie
      );
      // Calcula giro anual rolling 12m no ultimo ponto (sum saidas / avg estoque)
      const ultimos12 = serieRows.slice(-12);
      const saidasAcum = ultimos12.reduce((s, r) => s + Number(r.valor_saidas || 0), 0);
      const estoqueMedio = ultimos12.length > 0
        ? ultimos12.reduce((s, r) => s + Number(r.valor_estoque || 0), 0) / ultimos12.length
        : 0;
      const giroAnual = Calc.calcularGiroAnual(saidasAcum, estoqueMedio);
      const coberturaDias = Calc.calcularCoberturaDias(giroAnual);

      // Serie no formato pro Recharts.
      // dias_cobertura = quantos dias o estoque do mes duraria no ritmo de saida
      //                  daquele mes. = 30 / (saidas/estoque).
      // Se saidas=0 -> sem giro -> null (renderiza como "—" no front).
      const serie_12m = ultimos12.map(r => {
        const v = Number(r.valor_estoque || 0);
        const s = Number(r.valor_saidas || 0);
        const giroMensal = v > 0 && s > 0 ? s / v : 0;
        return {
          anoMes: r.ano_mes,
          valor_estoque: Number(v.toFixed(2)),
          valor_saidas: Number(s.toFixed(2)),
          giro_mensal: Number(giroMensal.toFixed(3)),
          dias_cobertura: giroMensal > 0 ? Math.round(30 / giroMensal) : null
        };
      });

      // 3) KPIs: comparativo com mes anterior
      const anoMesAnt = Calc.anoMesAnterior(anoMes);
      const ant = await Pg.connectAndQuery(`
        SELECT SUM(valor_estoque) v
          FROM tab_estoque_snapshot_mensal
         WHERE ${where.replace(/@anoMes/g, '@anoMesAnt')}`,
        { ...params, anoMesAnt }
      );
      const valorAtual = itensMes.reduce((s, i) => s + Number(i.valor_estoque || 0), 0);
      const valorAnt = Number(ant[0]?.v || 0);
      const deltaPct = valorAnt > 0 ? Number((((valorAtual - valorAnt) / valorAnt) * 100).toFixed(2)) : 0;

      const kpis = {
        valor_total: Number(valorAtual.toFixed(2)),
        valor_anterior: Number(valorAnt.toFixed(2)),
        delta_pct: deltaPct,
        qtd_itens: itensMes.length,
        giro_anual: giroAnual,
        cobertura_dias: coberturaDias
      };

      // 4) Curva ABC
      const abcFull = Calc.classificarABC(itensMes, (i) => Number(i.valor_estoque || 0));
      const abc = abcFull.map(i => ({
        cod_produto: String(i.cod_produto).trim(),
        descricao: String(i.descricao || '').trim(),
        tipo: String(i.tipo_produto || '').trim(),
        valor_estoque: Number(i.valor_estoque || 0),
        qtd_estoque: Number(i.qtd_estoque || 0),
        perc_acum: i.percAcum,
        classe: i.classe
      }));
      const totalsClasse = abc.reduce((acc, i) => {
        acc[i.classe].qtd += 1;
        acc[i.classe].valor += i.valor_estoque;
        return acc;
      }, { A: { qtd: 0, valor: 0 }, B: { qtd: 0, valor: 0 }, C: { qtd: 0, valor: 0 } });

      // 5) Sem giro: produtos que tiveram qtd_saidas = 0 nos ultimos N meses
      const anosMesLookback = Calc.ultimosAnoMes(semGiroMeses);
      const inAnosMes = anosMesLookback.map((_, i) => `@am${i}`).join(',');
      const paramsSem = { ...params };
      anosMesLookback.forEach((am, i) => { paramsSem[`am${i}`] = am; });
      const semGiro = await Pg.connectAndQuery(`
        SELECT cod_produto, MAX(descricao) descricao, MAX(tipo_produto) tipo_produto,
               SUM(qtd_estoque) qtd_estoque, SUM(valor_estoque) valor_estoque
          FROM tab_estoque_snapshot_mensal
         WHERE ano_mes = @anoMes ${tipo ? 'AND tipo_produto = @tipo' : ''} ${armazem ? 'AND armazem = @armazem' : ''}
           AND qtd_estoque > 0
           AND cod_produto NOT IN (
             SELECT cod_produto FROM tab_estoque_snapshot_mensal
              WHERE ano_mes IN (${inAnosMes}) AND qtd_saidas_mes > 0
           )
         GROUP BY cod_produto
         ORDER BY SUM(valor_estoque) DESC
         LIMIT 50`,
        paramsSem
      );

      // 6) Curva A com baixo giro (giro <= mediana global do tipo)
      // Calcula giro rolling 12m por produto e acha os classe A com giro abaixo da mediana
      const giro12mProd = await Pg.connectAndQuery(`
        WITH agreg AS (
          SELECT cod_produto,
                 SUM(valor_saidas_mes) saidas,
                 AVG(valor_estoque) estoque_medio
            FROM tab_estoque_snapshot_mensal
           WHERE ano_mes IN (${inAnosMes})
             ${tipo ? 'AND tipo_produto = @tipo' : ''}
             ${armazem ? 'AND armazem = @armazem' : ''}
           GROUP BY cod_produto
        )
        SELECT cod_produto, saidas, estoque_medio,
               CASE WHEN estoque_medio > 0 THEN saidas/estoque_medio ELSE 0 END giro
          FROM agreg`,
        paramsSem
      );
      const giroPorCod = new Map(giro12mProd.map(g => [String(g.cod_produto).trim(), Number(g.giro || 0)]));
      const giros = giro12mProd.map(g => Number(g.giro || 0)).filter(g => g > 0).sort((a, b) => a - b);
      const mediana = giros.length ? giros[Math.floor(giros.length / 2)] : 0;

      const curvaABaixoGiro = abc
        .filter(i => i.classe === 'A')
        .map(i => ({ ...i, giro: giroPorCod.get(i.cod_produto) || 0 }))
        .filter(i => i.giro < mediana || i.giro === 0)
        .slice(0, 30);

      // 7) Totais por tipo / armazem (pra paineis lateriais)
      const porTipo = await Pg.connectAndQuery(`
        SELECT tipo_produto, SUM(valor_estoque) valor, COUNT(DISTINCT cod_produto) qtd
          FROM tab_estoque_snapshot_mensal
         WHERE ano_mes = @anoMes
         GROUP BY tipo_produto
         ORDER BY SUM(valor_estoque) DESC`,
        { anoMes }
      );
      const porArmazem = await Pg.connectAndQuery(`
        SELECT armazem, SUM(valor_estoque) valor, COUNT(DISTINCT cod_produto) qtd
          FROM tab_estoque_snapshot_mensal
         WHERE ano_mes = @anoMes
         GROUP BY armazem
         ORDER BY SUM(valor_estoque) DESC`,
        { anoMes }
      );

      return res.json({
        vazio: false,
        anoMes,
        filtros: { tipo, armazem, semGiroMeses },
        kpis,
        serie_12m,
        abc,
        abc_totais: totalsClasse,
        sem_giro: semGiro.map(s => ({
          cod_produto: String(s.cod_produto).trim(),
          descricao: String(s.descricao || '').trim(),
          tipo: String(s.tipo_produto || '').trim(),
          qtd_estoque: Number(s.qtd_estoque || 0),
          valor_estoque: Number(s.valor_estoque || 0)
        })),
        curva_a_baixo_giro: curvaABaixoGiro.map(i => ({
          cod_produto: i.cod_produto,
          descricao: i.descricao,
          tipo: i.tipo,
          valor_estoque: i.valor_estoque,
          giro: Number(i.giro.toFixed(2)),
          mediana_geral: Number(mediana.toFixed(2))
        })),
        totais_por_tipo: porTipo.map(t => ({
          tipo: String(t.tipo_produto || '').trim(),
          valor: Number(t.valor || 0),
          qtd: Number(t.qtd || 0)
        })),
        totais_por_armazem: porArmazem.map(a => ({
          armazem: String(a.armazem || '').trim(),
          valor: Number(a.valor || 0),
          qtd: Number(a.qtd || 0)
        })),
        gerado_em: new Date().toISOString()
      });
    } catch (err) {
      console.error('estoque-valor:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

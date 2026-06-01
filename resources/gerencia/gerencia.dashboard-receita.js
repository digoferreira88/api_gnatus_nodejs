// GET /gerencia/dashboard-receita?inicio=YYYYMMDD&fim=YYYYMMDD
//
// Devolve o pacote completo do dashboard de Receita (replica visual do
// Power BI que o usuario tinha). Roda 2x as queries — periodo atual e o
// MESMO periodo no ano anterior — pra calcular variacao YoY dos KPIs e
// renderizar a sparkline de 12 meses.
//
// Fonte de dados:
//   Receita      SF2010 + SD2010 (CFOPs de venda — mesma lista do DRE)
//   CMV          SD2010.D2_CUSTO1
//   Despesas     SE2010 agrupadas pela tab_natureza_classificacao
//   Clientes     SA1010 (nome para exibir)
//
// Permissao 10001 (DRE Gerencial).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10001]);

const toN = (v) => Number(v || 0);
const trim = (v) => String(v || '').trim();

// CFOPs de venda — espelha gerencia.dre.js. Mantido aqui pra independencia
// (se mudar lista la, atualizar aqui tambem; sao 20+CFOPs estaveis).
const CFOPS_VENDA = ['5105', '5106', '5116', '5117', '5119', '5405', '5933',
  '6105', '6106', '6107', '6108', '6109', '6110', '6116', '6117',
  '6119', '6122', '6123', '6404', '6933', '5907', '6907', '5924'];

const inClause = (list, prefix) => {
  const params = {};
  const keys = list.map((v, i) => { params[`${prefix}${i}`] = v; return `@${prefix}${i}`; });
  return { sql: keys.join(','), params };
};

// YYYYMMDD -> Date UTC (00:00)
function ymd2date(s) {
  const t = trim(s).replace(/\D/g, '');
  if (t.length !== 8) return null;
  return new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8)));
}
// Date -> YYYYMMDD
function date2ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}
// 'YYYYMM' do periodo
function ymOf(s) { return trim(s).slice(0, 6); }

// Subtrai 1 ano de YYYYMMDD (cuidando de 29/02)
function minus1Year(ymd) {
  const d = ymd2date(ymd);
  if (!d) return ymd;
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return date2ymd(d);
}

// Variacao percentual (a vs b). b=0 e a>0 → 100; b=0 e a=0 → 0.
function pctVar(a, b) {
  if (!b) return a ? 100 : 0;
  return ((a - b) / b) * 100;
}

// Carrega o mapping de classificacao (do PG). Retorna { byPrefix: Map }
async function carregarClassificacao(Pg) {
  const rows = await Pg.connectAndQuery(`
    SELECT natureza, tipo, classificacao, operacional
      FROM tab_natureza_classificacao`);
  const m = new Map();
  rows.forEach(r => m.set(trim(r.natureza), {
    tipo: trim(r.tipo),
    classificacao: trim(r.classificacao),
    operacional: r.operacional !== false
  }));
  return m;
}

// Classifica uma natureza SE2 (E2_NATUREZ) buscando primeiro o codigo exato,
// depois o prefixo de 3 chars. Default: DESPESA / FIXO / operacional.
function classificarNatureza(naturezaRaw, mapa) {
  const n = trim(naturezaRaw);
  if (mapa.has(n)) return mapa.get(n);
  const p = n.slice(0, 3);
  if (mapa.has(p)) return mapa.get(p);
  return { tipo: 'DESPESA', classificacao: 'FIXO', operacional: true };
}

// ============== Roda 1 periodo (inicio,fim) ==============
async function carregarPeriodo({ Protheus, filial, inicio, fim, mapaNat }) {
  const inV = inClause(CFOPS_VENDA, 'cv');

  // Receita por mês (YYYYMM) + total no periodo + receita por cliente
  const sqlReceitaMes = `
    SELECT LEFT(sd2.D2_EMISSAO, 6) ym,
           SUM(sd2.D2_TOTAL) receita,
           SUM(sd2.D2_CUSTO1) cmv
      FROM SD2010 sd2 WITH (NOLOCK)
      INNER JOIN SF2010 sf2 WITH (NOLOCK)
        ON sf2.F2_FILIAL = sd2.D2_FILIAL AND sf2.F2_DOC = sd2.D2_DOC
       AND sf2.F2_SERIE = sd2.D2_SERIE AND sf2.F2_CLIENTE = sd2.D2_CLIENTE
       AND sf2.F2_LOJA = sd2.D2_LOJA AND sf2.D_E_L_E_T_ <> '*'
     WHERE sd2.D_E_L_E_T_ <> '*' AND sd2.D2_FILIAL = @filial
       AND sd2.D2_EMISSAO BETWEEN @inicio AND @fim
       AND sf2.F2_EMISSAO BETWEEN @inicio AND @fim
       AND RTRIM(sd2.D2_CF) IN (${inV.sql})
     GROUP BY LEFT(sd2.D2_EMISSAO, 6)
     ORDER BY ym`;

  const sqlReceitaCliente = `
    SELECT RTRIM(sd2.D2_CLIENTE) cliente_cod,
           RTRIM(sd2.D2_LOJA)    cliente_loja,
           MAX(RTRIM(sa1.A1_NOME)) nome,
           SUM(sd2.D2_TOTAL)  receita,
           SUM(sd2.D2_CUSTO1) cmv
      FROM SD2010 sd2 WITH (NOLOCK)
      INNER JOIN SF2010 sf2 WITH (NOLOCK)
        ON sf2.F2_FILIAL = sd2.D2_FILIAL AND sf2.F2_DOC = sd2.D2_DOC
       AND sf2.F2_SERIE = sd2.D2_SERIE AND sf2.F2_CLIENTE = sd2.D2_CLIENTE
       AND sf2.F2_LOJA = sd2.D2_LOJA AND sf2.D_E_L_E_T_ <> '*'
      LEFT JOIN SA1010 sa1 WITH (NOLOCK)
        ON sa1.A1_FILIAL = '' AND sa1.A1_COD = sd2.D2_CLIENTE
       AND sa1.A1_LOJA = sd2.D2_LOJA AND sa1.D_E_L_E_T_ <> '*'
     WHERE sd2.D_E_L_E_T_ <> '*' AND sd2.D2_FILIAL = @filial
       AND sd2.D2_EMISSAO BETWEEN @inicio AND @fim
       AND sf2.F2_EMISSAO BETWEEN @inicio AND @fim
       AND RTRIM(sd2.D2_CF) IN (${inV.sql})
     GROUP BY sd2.D2_CLIENTE, sd2.D2_LOJA`;

  // Despesas SE2 por (mes, natureza) — vamos classificar em JS usando o mapa
  // (custo/despesa/receita, variavel/fixo, operacional). Excluimos 201/202/203
  // porque ja entram via CMV (mesma logica do DRE).
  const sqlDespesasMes = `
    SELECT LEFT(se2.E2_EMISSAO, 6) ym,
           RTRIM(se2.E2_NATUREZ) natureza,
           SUM(se2.E2_VALOR) valor
      FROM SE2010 se2 WITH (NOLOCK)
     WHERE se2.D_E_L_E_T_ <> '*' AND se2.E2_FILIAL = @filial
       AND se2.E2_EMISSAO BETWEEN @inicio AND @fim
       AND LEFT(RTRIM(se2.E2_NATUREZ), 3) NOT IN ('201','202','203')
     GROUP BY LEFT(se2.E2_EMISSAO, 6), se2.E2_NATUREZ`;

  const params = { filial, inicio, fim, ...inV.params };

  const [receitaMes, receitaCliente, despesasMes] = await Promise.all([
    Protheus.connectAndQuery(sqlReceitaMes, params),
    Protheus.connectAndQuery(sqlReceitaCliente, params),
    Protheus.connectAndQuery(sqlDespesasMes, { filial, inicio, fim })
  ]);

  // Agrega receita/lucro/cmv por mes
  const seriesByYm = new Map();
  receitaMes.forEach(r => {
    const ym = trim(r.ym);
    seriesByYm.set(ym, {
      ym,
      receita: toN(r.receita),
      cmv: toN(r.cmv),
      despesaOp: 0, despesaVar: 0, despesaFixa: 0,
      despesaNaoOp: 0
    });
  });

  // Soma SE2 por mes aplicando classificacao
  let despesasOpTotal = 0;
  let despesasNaoOpTotal = 0;
  let custosVariaveisExtra = 0;   // custos via SE2 (raro — quase tudo eh CMV)
  let despesasFixasTotal = 0;
  let despesasVariaveisTotal = 0;
  despesasMes.forEach(d => {
    const cls = classificarNatureza(d.natureza, mapaNat);
    const v = toN(d.valor);
    const ym = trim(d.ym);
    let bucket = seriesByYm.get(ym);
    if (!bucket) {
      bucket = { ym, receita: 0, cmv: 0, despesaOp: 0, despesaVar: 0, despesaFixa: 0, despesaNaoOp: 0 };
      seriesByYm.set(ym, bucket);
    }
    if (cls.operacional) {
      bucket.despesaOp += v;
      despesasOpTotal += v;
    } else {
      bucket.despesaNaoOp += v;
      despesasNaoOpTotal += v;
    }
    if (cls.classificacao === 'VARIAVEL') {
      bucket.despesaVar += v;
      despesasVariaveisTotal += v;
      if (cls.tipo === 'CUSTO') custosVariaveisExtra += v;
    } else if (cls.classificacao === 'FIXO') {
      bucket.despesaFixa += v;
      despesasFixasTotal += v;
    }
  });

  const seriesMensais = [...seriesByYm.values()].sort((a, b) => a.ym.localeCompare(b.ym));
  seriesMensais.forEach(s => { s.lucro = s.receita - s.cmv - s.despesaOp - s.despesaNaoOp; });

  // Totais do periodo
  const receitaTotal = seriesMensais.reduce((a, s) => a + s.receita, 0);
  const cmvTotal = seriesMensais.reduce((a, s) => a + s.cmv, 0);
  // "Custos Totais" = CMV (direct) + custos VARIAVEIS lancados via SE2 (raro)
  const custosTotais = cmvTotal + custosVariaveisExtra;
  // "Despesas Totais" = SE2 menos a parte ja contada como custo
  const despesasTotais = (despesasOpTotal + despesasNaoOpTotal) - custosVariaveisExtra;
  const lucroLiquido = receitaTotal - custosTotais - despesasTotais;
  const margemLucroPct = receitaTotal ? (lucroLiquido / receitaTotal) * 100 : 0;
  // Margem bruta = (Receita - CMV) / Receita
  const margemBrutaPct = receitaTotal ? ((receitaTotal - cmvTotal) / receitaTotal) * 100 : 0;

  // Receita por origem
  const receitaOpVsNaoOp = {
    operacional: receitaTotal,     // hoje toda receita SF2 vai como operacional
    naoOperacional: 0              // (placeholder; financeiro pode marcar SED especificos no futuro)
  };

  // Top 5 clientes + detalhamento
  const clientes = receitaCliente.map(c => {
    const receita = toN(c.receita);
    const cmv = toN(c.cmv);
    const margemBruta = receita - cmv;
    return {
      cod: trim(c.cliente_cod),
      loja: trim(c.cliente_loja),
      nome: trim(c.nome) || `Cliente ${trim(c.cliente_cod)}`,
      receita, cmv, margemBruta,
      margemPct: receita ? (margemBruta / receita) * 100 : 0
    };
  }).sort((a, b) => b.receita - a.receita);

  const clientesAtivos = clientes.length;

  return {
    receitaTotal, custosTotais, despesasTotais, lucroLiquido,
    margemLucroPct, margemBrutaPct,
    despesasOpTotal, despesasNaoOpTotal,
    despesasVariaveisTotal, despesasFixasTotal,
    cmvTotal,
    clientesAtivos,
    receitaOpVsNaoOp,
    seriesMensais,
    clientes
  };
}

// ============== Endpoint ==============
module.exports = (app) => ({
  verb: 'get',
  route: '/dashboard-receita',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const inicio = trim(req.query.inicio);
    const fim = trim(req.query.fim);
    if (!/^\d{8}$/.test(inicio) || !/^\d{8}$/.test(fim)) {
      return res.status(400).json({ message: 'Parametros inicio/fim devem ser YYYYMMDD.' });
    }
    if (inicio > fim) {
      return res.status(400).json({ message: 'inicio precisa ser <= fim.' });
    }

    const t0 = Date.now();
    const filial = '01';
    try {
      const mapaNat = await carregarClassificacao(app.services.Pg);

      // Periodo atual + mesmo periodo no ano anterior (pra YoY)
      const inicioAnt = minus1Year(inicio);
      const fimAnt = minus1Year(fim);

      const [atual, anterior] = await Promise.all([
        carregarPeriodo({ Protheus: app.services.Protheus, filial, inicio, fim, mapaNat }),
        carregarPeriodo({ Protheus: app.services.Protheus, filial, inicio: inicioAnt, fim: fimAnt, mapaNat })
      ]);

      // KPIs do topo
      const kpis = {
        receitaTotal: {
          valor: atual.receitaTotal,
          variacaoPct: pctVar(atual.receitaTotal, anterior.receitaTotal),
          serie: atual.seriesMensais.map(s => s.receita)
        },
        custosTotais: {
          valor: atual.custosTotais,
          variacaoPct: pctVar(atual.custosTotais, anterior.custosTotais),
          serie: atual.seriesMensais.map(s => s.cmv)
        },
        despesasTotais: {
          valor: atual.despesasTotais,
          variacaoPct: pctVar(atual.despesasTotais, anterior.despesasTotais),
          serie: atual.seriesMensais.map(s => s.despesaOp + s.despesaNaoOp)
        },
        lucroLiquido: {
          valor: atual.lucroLiquido,
          variacaoPct: pctVar(atual.lucroLiquido, anterior.lucroLiquido),
          serie: atual.seriesMensais.map(s => s.lucro)
        },
        margemLucro: {
          valor: atual.margemLucroPct,
          variacaoPp: atual.margemLucroPct - anterior.margemLucroPct,    // p.p. — pontos percentuais
          serie: atual.seriesMensais.map(s => s.receita ? (s.lucro / s.receita) * 100 : 0)
        },
        clientesAtivos: {
          valor: atual.clientesAtivos,
          variacaoPct: pctVar(atual.clientesAtivos, anterior.clientesAtivos),
          serie: []   // sparkline de qt cliente nao faz sentido sem rodar query por mes
        }
      };

      // Detalhamento por cliente — top 50 pra nao explodir o response
      const detalhamento = atual.clientes.slice(0, 50);

      // Top 5
      const top5 = atual.clientes.slice(0, 5).map(c => ({
        cod: c.cod, loja: c.loja, nome: c.nome, receita: c.receita
      }));

      // Custos e despesas por tipo (mensal, stacked 100%)
      const custosDespesasPorTipo = atual.seriesMensais.map(s => {
        const total = s.cmv + s.despesaVar + s.despesaFixa;
        return {
          ym: s.ym,
          variavel: s.cmv + s.despesaVar,   // CMV eh variavel por natureza
          fixo: s.despesaFixa,
          variavelPct: total ? ((s.cmv + s.despesaVar) / total) * 100 : 0,
          fixoPct: total ? (s.despesaFixa / total) * 100 : 0
        };
      });

      // Donut Custos vs Despesas
      const custosVsDespesas = {
        custos: atual.custosTotais,
        despesas: atual.despesasTotais
      };

      // Saidas por tipo (bar horizontal)
      const totalSaidas = atual.custosTotais + atual.despesasTotais;
      const saidasPorTipo = [
        { tipo: 'Custos (CMV + variáveis)', valor: atual.custosTotais, pct: totalSaidas ? (atual.custosTotais / totalSaidas) * 100 : 0 },
        { tipo: 'Despesas Fixas', valor: atual.despesasFixasTotal, pct: totalSaidas ? (atual.despesasFixasTotal / totalSaidas) * 100 : 0 },
        { tipo: 'Despesas Variáveis (SE2)', valor: Math.max(0, atual.despesasVariaveisTotal - atual.cmvTotal), pct: totalSaidas ? (Math.max(0, atual.despesasVariaveisTotal - atual.cmvTotal) / totalSaidas) * 100 : 0 },
        { tipo: 'Despesas Não Operacionais', valor: atual.despesasNaoOpTotal, pct: totalSaidas ? (atual.despesasNaoOpTotal / totalSaidas) * 100 : 0 }
      ].filter(x => x.valor > 0);

      return res.json({
        periodo: { inicio, fim },
        periodoAnterior: { inicio: inicioAnt, fim: fimAnt },
        kpis,
        seriesMensais: atual.seriesMensais.map(s => ({
          ym: s.ym, receita: s.receita, lucro: s.lucro, cmv: s.cmv,
          despesaOp: s.despesaOp, despesaNaoOp: s.despesaNaoOp
        })),
        receitaPorOrigem: atual.receitaOpVsNaoOp,
        topClientes: top5,
        custosDespesasPorTipo,
        custosVsDespesas,
        margens: { bruta: atual.margemBrutaPct, liquida: atual.margemLucroPct },
        saidasPorTipo,
        detalhamentoPorCliente: detalhamento,
        crescimentoReceita: kpis.receitaTotal.variacaoPct,
        latenciaMs: Date.now() - t0,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('dashboard-receita:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

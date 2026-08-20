// Contas a Receber (titulos em aberto) vs Inadimplencia (VENCIDO 30-360 dias) por
// MES de emissao do titulo. % inadimplencia = inadimplencia / contas a receber.
// - Base = SE1 (saldo > 0), nao mais o faturamento (SF2). (decisao 20/08)
// - Inadimplencia = atraso 30..360 dias; >360 so entra com ?incluir360mais=1.
// - Filtro escondido (status flagados pela gestora) SEMPRE aplicado.
// - Equipes = B2B / B2C (B2C = Comercial Varejo, Digital, Representantes).
//
// GET /cobranca/faturamento-vs-inadimplencia?anoMin&anoMax&metaPct&equipe(B2B|B2C)&incluir360mais

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

const B2C_EQUIPES = ['Comercial Varejo', 'Digital', 'Representantes'];

const FatInadFiltros = require('../../services/cobrancaFatInadFiltros');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002, 9003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/faturamento-vs-inadimplencia',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;

    const anoAtual = new Date().getFullYear();
    const anoMin = Number(req.query.anoMin) || (anoAtual - 1);
    const anoMax = Number(req.query.anoMax) || anoAtual;
    if (anoMin < 2018 || anoMax > 2050 || anoMin > anoMax) {
      return res.status(400).json({ message: 'Parametros anoMin/anoMax invalidos.' });
    }

    const equipe = trim(req.query.equipe);   // '', 'B2B' ou 'B2C'
    const inc360 = /^(1|true|sim|on)$/i.test(String(req.query.incluir360mais || '')) ? 1 : 0;

    const inicioStr = `${anoMin}0101`;
    const fimStr    = `${anoMax}1231`;

    const ATRASO = `DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, GETDATE()))`;
    // Inadimplencia = 30..360 dias de atraso (default). >360 so com o checkbox.
    const INAD_COND = `(${ATRASO} >= 30 AND (${ATRASO} <= 360 OR @inc360 = 1))`;
    const BU_EXPR = `COALESCE(NULLIF(RTRIM(bu_sx5.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO) + ' (Desconhecido)')`;

    const sqlParams = { ini: inicioStr, fim: fimStr, inc360 };

    // ===== Equipe B2B/B2C (pra topClientes / aging / por-equipe) =====
    let condBuInad = '', joinSx5 = false;
    if (equipe === 'B2C' || equipe === 'B2B') {
      try {
        const b2cRows = await Pg.connectAndQuery(
          `SELECT DISTINCT bu_codigo FROM tab_cobranca_bu_equipe
            WHERE equipe IN ('Comercial Varejo','Digital','Representantes')`, {});
        const labels = b2cRows.map(r => trim(r.bu_codigo)).filter(Boolean);
        if (labels.length) {
          const inBu = labels.map((_, i) => `@bu${i}`).join(',');
          labels.forEach((b, i) => { sqlParams[`bu${i}`] = b; });
          condBuInad = equipe === 'B2C'
            ? `AND ${BU_EXPR} IN (${inBu})`
            : `AND (${BU_EXPR} NOT IN (${inBu}) OR ${BU_EXPR} IS NULL)`;
          joinSx5 = true;
        } else if (equipe === 'B2C') {
          condBuInad = 'AND 1 = 0';
        }
      } catch (e) { console.warn('fat-vs-inad equipe:', e.message); }
    }

    // ===== Filtro escondido (SEMPRE): exclui clientes com status flagado =====
    // Mesma regra do dashboard: status_excluidos (tab_cobranca_filtro_status) ->
    // clientes com esse status de cobranca sao removidos de TUDO (CR, inad, aging...).
    const clientesExcluidosSql = [];
    try {
      const cfgRows = await Pg.connectAndQuery(`SELECT status_excluidos FROM tab_cobranca_filtro_status WHERE id = 1`, {});
      let ex = cfgRows[0] && cfgRows[0].status_excluidos;
      if (typeof ex === 'string') { try { ex = JSON.parse(ex); } catch { ex = []; } }
      const setEx = new Set(Array.isArray(ex) ? ex : []);
      if (setEx.size) {
        const stRows = await Pg.connectAndQuery(`SELECT cliente_cod, cliente_loja, status FROM tab_cobranca_status_cliente`, {});
        stRows.forEach(s => {
          if (setEx.has(trim(s.status))) {
            const cod = trim(s.cliente_cod).replace(/'/g, ''), loja = trim(s.cliente_loja).replace(/'/g, '');
            if (cod) clientesExcluidosSql.push({ cod, loja });
          }
        });
      }
    } catch (e) { console.warn('fat-vs-inad filtro escondido:', e.message); }
    const excluiSql = (colCli, colLoja) => clientesExcluidosSql.length
      ? ` AND (RTRIM(${colCli}) + '|' + RTRIM(${colLoja})) NOT IN (${clientesExcluidosSql.map(c => `'${c.cod}|${c.loja}'`).join(',')})`
      : '';

    // Filtros da tela (cliente/uf/bu/forma/carteira/equipe) -> fragmentos SQL (helper compartilhado)
    const fi = await FatInadFiltros.montar({ Pg }, req.query);
    Object.assign(sqlParams, fi.params);

    try {
      const joinSx5Bu = joinSx5 ? `LEFT JOIN SX5010 bu_sx5 WITH (NOLOCK)
                ON bu_sx5.X5_FILIAL = '  ' AND bu_sx5.X5_TABELA = 'Z1'
               AND RTRIM(bu_sx5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND bu_sx5.D_E_L_E_T_ <> '*'` : '';
      const joinSc5Inad = (equipe === 'B2B' || equipe === 'B2C') ? `LEFT JOIN SC5010 sc5 WITH (NOLOCK)
                ON sc5.C5_FILIAL = se1.E1_FILIAL AND sc5.C5_NUM = se1.E1_PEDIDO AND sc5.D_E_L_E_T_ <> '*'
              ${joinSx5Bu}` : '';

      // 1) Contas a Receber (todos os abertos) + Inadimplencia (30-360) por mes de emissao
      const crInadRows = await Protheus.connectAndQuery(`
        SELECT SUBSTRING(se1.E1_EMISSAO, 1, 6) ymes,
               SUM(se1.E1_SALDO) contasReceber,
               SUM(CASE WHEN ${INAD_COND} THEN se1.E1_SALDO ELSE 0 END) inadimplencia,
               SUM(CASE WHEN ${INAD_COND} THEN 1 ELSE 0 END) qtdInad
          FROM SE1010 se1 WITH (NOLOCK)
          ${fi.inadJoins}
         WHERE se1.D_E_L_E_T_ <> '*'
           AND se1.E1_FILIAL = '01'
           AND se1.E1_SALDO > 0
           AND se1.E1_EMISSAO BETWEEN @ini AND @fim
           AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
           ${fi.inadWhere}
           ${excluiSql('se1.E1_CLIENTE', 'se1.E1_LOJA')}
         GROUP BY SUBSTRING(se1.E1_EMISSAO, 1, 6)
         ORDER BY ymes`,
        sqlParams
      );

      const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
      const serie = crInadRows.map(r => {
        const k = trim(r.ymes);
        const ano = k.slice(0, 4), mes = Number(k.slice(4, 6));
        const cr = toN(r.contasReceber), inad = toN(r.inadimplencia);
        const pct = cr > 0 ? (inad / cr) * 100 : 0;
        return {
          ymes: k, ano, mes, label: `${meses[mes - 1]}/${ano.slice(2)}`,
          contasReceber: Number(cr.toFixed(2)),
          inadimplencia: Number(inad.toFixed(2)),
          qtdTitulos: toN(r.qtdInad),
          pctInadimplencia: Number(pct.toFixed(2))
        };
      });

      const totCR   = serie.reduce((s, x) => s + x.contasReceber, 0);
      const totInad = serie.reduce((s, x) => s + x.inadimplencia, 0);
      const totQtd  = serie.reduce((s, x) => s + x.qtdTitulos, 0);
      const pctAtual = totCR > 0 ? (totInad / totCR) * 100 : 0;
      const ticketMedio = totQtd > 0 ? totInad / totQtd : 0;

      // Meta (% sobre contas a receber)
      const metaPct = Number(req.query.metaPct) || 6;
      const inadAlvo = totCR * (metaPct / 100);
      const excessoParaMeta = Math.max(0, totInad - inadAlvo);

      // Top 15 clientes inadimplentes (pareto)
      const topClientes = await Protheus.connectAndQuery(`
        SELECT TOP 15
               RTRIM(se1.E1_CLIENTE) cod, RTRIM(se1.E1_LOJA) loja,
               RTRIM(COALESCE(NULLIF(sa1.A1_NOME, ''), se1.E1_NOMCLI)) nome,
               RTRIM(sa1.A1_EST) uf,
               SUM(se1.E1_SALDO) saldo, COUNT(*) qtd,
               MAX(${ATRASO}) maiorAtraso
          FROM SE1010 se1 WITH (NOLOCK)
          LEFT JOIN SA1010 sa1 WITH (NOLOCK)
            ON sa1.A1_COD = se1.E1_CLIENTE AND sa1.A1_LOJA = se1.E1_LOJA AND sa1.D_E_L_E_T_ <> '*'
          ${joinSc5Inad}
         WHERE se1.D_E_L_E_T_ <> '*' AND se1.E1_FILIAL = '01'
           AND se1.E1_SALDO > 0 AND ${INAD_COND}
           AND se1.E1_EMISSAO BETWEEN @ini AND @fim
           AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
           ${condBuInad}
           ${excluiSql('se1.E1_CLIENTE', 'se1.E1_LOJA')}
         GROUP BY se1.E1_CLIENTE, se1.E1_LOJA, sa1.A1_NOME, se1.E1_NOMCLI, sa1.A1_EST
         ORDER BY SUM(se1.E1_SALDO) DESC`,
        sqlParams
      );

      // Aging (30-60 ... >360). Faixa 1-29 removida; >360 so aparece se inc360.
      const FAIXA_CASE = `CASE
            WHEN ${ATRASO} <= 60  THEN 'B_30_60'
            WHEN ${ATRASO} <= 90  THEN 'C_61_90'
            WHEN ${ATRASO} <= 180 THEN 'D_91_180'
            WHEN ${ATRASO} <= 360 THEN 'E_181_360'
            ELSE 'F_360_MAIS' END`;
      const agingRows = await Protheus.connectAndQuery(`
        SELECT ${FAIXA_CASE} faixa, SUM(se1.E1_SALDO) saldo, COUNT(*) qtd
          FROM SE1010 se1 WITH (NOLOCK)
          ${joinSc5Inad}
         WHERE se1.D_E_L_E_T_ <> '*' AND se1.E1_FILIAL = '01'
           AND se1.E1_SALDO > 0 AND ${INAD_COND}
           AND se1.E1_EMISSAO BETWEEN @ini AND @fim
           AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
           ${condBuInad}
           ${excluiSql('se1.E1_CLIENTE', 'se1.E1_LOJA')}
         GROUP BY ${FAIXA_CASE}`,
        sqlParams
      );
      const FAIXAS_LABEL = { B_30_60: '30-60 dias', C_61_90: '61-90 dias', D_91_180: '91-180 dias', E_181_360: '181-360 dias', F_360_MAIS: '>360 dias' };
      const aging = agingRows.map(r => ({
        faixa: trim(r.faixa), label: FAIXAS_LABEL[trim(r.faixa)] || trim(r.faixa),
        saldo: Number(toN(r.saldo).toFixed(2)), qtd: toN(r.qtd),
        pct_da_inadimplencia: totInad > 0 ? Number(((toN(r.saldo) / totInad) * 100).toFixed(2)) : 0
      })).sort((a, b) => a.faixa.localeCompare(b.faixa));

      // Inadimplencia por B2B / B2C
      let porEquipe = [];
      try {
        const buEqRows = await Pg.connectAndQuery(`SELECT bu_codigo, equipe FROM tab_cobranca_bu_equipe`, {});
        const mapBuEquipe = new Map();
        buEqRows.forEach(r => mapBuEquipe.set(trim(r.bu_codigo), trim(r.equipe)));
        const setB2C = new Set(B2C_EQUIPES);
        const inadBuRows = await Protheus.connectAndQuery(`
          SELECT ${BU_EXPR} buLabel, SUM(se1.E1_SALDO) saldo, COUNT(*) qtd
            FROM SE1010 se1 WITH (NOLOCK)
            LEFT JOIN SC5010 sc5 WITH (NOLOCK)
              ON sc5.C5_FILIAL = se1.E1_FILIAL AND sc5.C5_NUM = se1.E1_PEDIDO AND sc5.D_E_L_E_T_ <> '*'
            LEFT JOIN SX5010 bu_sx5 WITH (NOLOCK)
              ON bu_sx5.X5_FILIAL = '  ' AND bu_sx5.X5_TABELA = 'Z1'
             AND RTRIM(bu_sx5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND bu_sx5.D_E_L_E_T_ <> '*'
           WHERE se1.D_E_L_E_T_ <> '*' AND se1.E1_FILIAL = '01'
             AND se1.E1_SALDO > 0 AND ${INAD_COND}
             AND se1.E1_EMISSAO BETWEEN @ini AND @fim
             AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
             ${condBuInad}
             ${excluiSql('se1.E1_CLIENTE', 'se1.E1_LOJA')}
           GROUP BY ${BU_EXPR}`,
          sqlParams
        );
        const bc = { B2C: { equipe: 'B2C', saldo: 0, qtd: 0 }, B2B: { equipe: 'B2B', saldo: 0, qtd: 0 } };
        inadBuRows.forEach(r => {
          const eq = mapBuEquipe.get(trim(r.buLabel)) || 'Sem equipe';
          const cat = setB2C.has(eq) ? 'B2C' : 'B2B';
          bc[cat].saldo += toN(r.saldo); bc[cat].qtd += toN(r.qtd);
        });
        porEquipe = [bc.B2C, bc.B2B]
          .filter(e => e.saldo > 0 || e.qtd > 0)
          .map(e => ({
            equipe: e.equipe, saldo: Number(e.saldo.toFixed(2)), qtd: e.qtd,
            pct_da_inadimplencia: totInad > 0 ? Number(((e.saldo / totInad) * 100).toFixed(2)) : 0
          }))
          .sort((a, b) => b.saldo - a.saldo);
      } catch (e) { console.warn('fat-vs-inad porEquipe:', e.message); }

      // Recomendacoes
      const recomendacoes = [];
      const fmt = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (pctAtual > metaPct) {
        recomendacoes.push(`Reduzir inadimplencia em R$ ${fmt(excessoParaMeta)} pra bater a meta de ${metaPct}% sobre contas a receber.`);
        const top3 = topClientes.slice(0, 3);
        if (top3.length) {
          const soma3 = top3.reduce((s, c) => s + toN(c.saldo), 0);
          const pctTop3 = totInad > 0 ? (soma3 / totInad) * 100 : 0;
          recomendacoes.push(`Os 3 maiores inadimplentes concentram R$ ${fmt(soma3)} (${pctTop3.toFixed(1)}% do total) — focar neles tem maior alavancagem.`);
        }
        const longo = aging.filter(a => ['D_91_180', 'E_181_360', 'F_360_MAIS'].includes(a.faixa)).reduce((s, a) => s + a.saldo, 0);
        const pctLongo = totInad > 0 ? (longo / totInad) * 100 : 0;
        if (pctLongo > 30) recomendacoes.push(`${pctLongo.toFixed(1)}% da inadimplencia e de >90 dias (R$ ${fmt(longo)}) — avaliar protesto, juridico ou PERDA.`);
        if (porEquipe.length && porEquipe[0].pct_da_inadimplencia > 60) {
          recomendacoes.push(`${porEquipe[0].equipe} responde por ${porEquipe[0].pct_da_inadimplencia}% da inadimplencia.`);
        }
      } else {
        recomendacoes.push(`Inadimplencia esta DENTRO da meta de ${metaPct}%. Folga de R$ ${fmt(inadAlvo - totInad)} antes de atingir o limite.`);
      }

      return res.json({
        periodo: { anoMin, anoMax },
        equipe: equipe || null,
        incluir360mais: !!inc360,
        meta: {
          pct: metaPct,
          inadimplencia_alvo: Number(inadAlvo.toFixed(2)),
          excesso_para_meta: Number(excessoParaMeta.toFixed(2)),
          dentro_da_meta: pctAtual <= metaPct,
          delta_pp: Number((pctAtual - metaPct).toFixed(2))
        },
        totais: {
          contasReceber: Number(totCR.toFixed(2)),
          inadimplencia: Number(totInad.toFixed(2)),
          pctInadimplencia: Number(pctAtual.toFixed(2)),
          qtdTitulosInad: totQtd,
          ticketMedio: Number(ticketMedio.toFixed(2))
        },
        serie,
        analise: {
          top_clientes: topClientes.map(c => ({
            cod: trim(c.cod), loja: trim(c.loja), nome: trim(c.nome), uf: trim(c.uf),
            saldo: Number(toN(c.saldo).toFixed(2)), qtd: toN(c.qtd), maior_atraso: toN(c.maiorAtraso),
            pct_da_inadimplencia: totInad > 0 ? Number(((toN(c.saldo) / totInad) * 100).toFixed(2)) : 0
          })),
          aging,
          top_equipes: porEquipe,
          recomendacoes
        },
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro cobranca/faturamento-vs-inadimplencia:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

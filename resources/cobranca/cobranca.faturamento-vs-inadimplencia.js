// Faturamento (NF saida) vs Inadimplencia (titulos nao pagos do MESMO periodo
// emissao). Compara mes a mes — gestor ve quanto do que foi faturado virou
// inadimplencia no mesmo mes.
//
// GET /cobranca/faturamento-vs-inadimplencia?anoMin=YYYY&anoMax=YYYY
//
// Faturamento: SF2 (notas saida) somando F2_VALBRUT por mes de emissao,
//   filtrado por CFOPs de venda (mesma lista do relatorio de faturamento).
// Inadimplencia: SE1 (titulos a receber) onde SALDO > 0 (nao pago) e
//   E1_VENCREA <= hoje (vencido), agrupado por mes de E1_EMISSAO.

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

// CFOPs de venda — alinhado com vendas/faturamento-relatorio
const CFOPS_VENDA = [
  '5101','5102','5103','5104','5105','5106','5109','5110','5111','5112','5113','5114','5115','5116','5117','5118','5119','5120','5122','5123','5129',
  '5251','5252','5253','5254','5255','5256','5257','5258','5301','5302','5303','5304','5305','5306','5307','5351','5352','5353','5354','5355','5356','5357','5359','5360',
  '5401','5402','5403','5405','5651','5652','5653','5654','5655','5656','5667','5932','5933',
  '6101','6102','6103','6104','6105','6106','6107','6108','6109','6110','6111','6112','6113','6114','6115','6116','6117','6118','6119','6120','6122','6123','6129',
  '6251','6252','6253','6254','6255','6256','6257','6258','6301','6302','6303','6304','6305','6306','6307','6351','6352','6353','6354','6355','6356','6357','6359','6360',
  '6401','6402','6403','6404','6651','6652','6653','6654','6655','6656','6667','6932','6933',
  '7101','7102','7105','7106','7127','7129','7251','7301','7358','7651','7654','7667'
];

module.exports = (app) => ({
  verb: 'get',
  route: '/faturamento-vs-inadimplencia',

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;

    const anoAtual = new Date().getFullYear();
    const anoMin = Number(req.query.anoMin) || (anoAtual - 1);
    const anoMax = Number(req.query.anoMax) || anoAtual;
    if (anoMin < 2018 || anoMax > 2050 || anoMin > anoMax) {
      return res.status(400).json({ message: 'Parametros anoMin/anoMax invalidos.' });
    }

    const equipe = trim(req.query.equipe);

    const inicioStr = `${anoMin}0101`;
    const fimStr    = `${anoMax}1231`;
    const cfopList  = CFOPS_VENDA.map(c => `'${c}'`).join(',');

    // ============== Filtro de equipe (opcional) ==============
    // ATENCAO: tab_cobranca_bu_equipe.bu_codigo na pratica armazena a DESCRICAO
    // (label) da BU, nao o codigo C5_ZTIPO. Quando a BU nao tem descricao em
    // SX5, o label fica '<C5_ZTIPO> (Desconhecido)'. Por isso o WHERE precisa
    // comparar com a descricao calculada via JOIN+SX5, exatamente igual o
    // dashboard faz pra mapear BU -> equipe.
    let condBuFat = '', condBuInad = '';
    let joinSx5 = false;
    const sqlParams = { ini: inicioStr, fim: fimStr };

    if (equipe) {
      try {
        const eqRows = await Pg.connectAndQuery(
          `SELECT bu_codigo FROM tab_cobranca_bu_equipe WHERE equipe = @eq`,
          { eq: equipe }
        );
        const buLabels = eqRows.map(r => String(r.bu_codigo || '').trim()).filter(Boolean);
        if (buLabels.length === 0) {
          return res.json({
            periodo: { anoMin, anoMax }, equipe,
            totais: { faturado: 0, inadimplencia: 0, pctInadimplencia: 0 },
            serie: [],
            aviso: `Nenhuma BU mapeada pra equipe "${equipe}".`,
            geradoEm: new Date().toISOString()
          });
        }
        const inBu = buLabels.map((_, i) => `@bu${i}`).join(',');
        buLabels.forEach((b, i) => { sqlParams[`bu${i}`] = b; });
        // Reconstroi label exatamente como o dashboard: descricao SX5, ou
        // fallback '<cod> (Desconhecido)' se SX5 nao tem descricao.
        const exprBuLabel = `COALESCE(NULLIF(RTRIM(bu_sx5.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO) + ' (Desconhecido)')`;
        condBuFat  = `AND ${exprBuLabel} IN (${inBu})`;
        condBuInad = `AND ${exprBuLabel} IN (${inBu})`;
        joinSx5 = true;
      } catch (e) {
        console.warn('Falha ao traduzir equipe pra BUs:', e.message);
      }
    }

    try {
      // JOINs com SC5 (pedido) so quando ha filtro de equipe, pra evitar custo
      // desnecessario quando o usuario nao filtrou.
      const joinSx5Bu = joinSx5 ? `LEFT JOIN SX5010 bu_sx5 WITH (NOLOCK)
                                      ON bu_sx5.X5_FILIAL = '  ' AND bu_sx5.X5_TABELA = 'Z1'
                                     AND RTRIM(bu_sx5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO)
                                     AND bu_sx5.D_E_L_E_T_ <> '*'` : '';
      const joinSc5Fat  = equipe ? `LEFT JOIN SC5010 sc5 WITH (NOLOCK)
                                      ON sc5.C5_FILIAL = sd2.D2_FILIAL AND sc5.C5_NUM = sd2.D2_PEDIDO
                                     AND sc5.D_E_L_E_T_ <> '*'
                                    ${joinSx5Bu}` : '';
      const joinSc5Inad = equipe ? `LEFT JOIN SC5010 sc5 WITH (NOLOCK)
                                      ON sc5.C5_FILIAL = se1.E1_FILIAL AND sc5.C5_NUM = se1.E1_PEDIDO
                                     AND sc5.D_E_L_E_T_ <> '*'
                                    ${joinSx5Bu}` : '';

      // 1) Faturamento por mes (NF saida)
      const fatRows = await Protheus.connectAndQuery(`
        SELECT SUBSTRING(sf2.F2_EMISSAO, 1, 6) ymes,
               SUM(sd2.D2_VALBRUT) faturado
          FROM SF2010 sf2 WITH (NOLOCK)
          INNER JOIN SD2010 sd2 WITH (NOLOCK)
            ON sd2.D2_FILIAL = sf2.F2_FILIAL
           AND sd2.D2_DOC    = sf2.F2_DOC
           AND sd2.D2_SERIE  = sf2.F2_SERIE
           AND sd2.D2_CLIENTE = sf2.F2_CLIENTE
           AND sd2.D2_LOJA    = sf2.F2_LOJA
           AND sd2.D_E_L_E_T_ <> '*'
           AND sd2.D2_CF IN (${cfopList})
          ${joinSc5Fat}
         WHERE sf2.D_E_L_E_T_ <> '*'
           AND sf2.F2_FILIAL = '01'
           AND sf2.F2_EMISSAO BETWEEN @ini AND @fim
           ${condBuFat}
         GROUP BY SUBSTRING(sf2.F2_EMISSAO, 1, 6)
         ORDER BY ymes`,
        sqlParams
      );

      // 2) Inadimplencia por mes de EMISSAO do titulo (titulos nao pagos e VENCIDOS)
      // SE1 com saldo > 0 e vencimento real <= hoje
      const inadRows = await Protheus.connectAndQuery(`
        SELECT SUBSTRING(se1.E1_EMISSAO, 1, 6) ymes,
               SUM(se1.E1_SALDO) saldoVencido,
               COUNT(*) qtdTitulos
          FROM SE1010 se1 WITH (NOLOCK)
          ${joinSc5Inad}
         WHERE se1.D_E_L_E_T_ <> '*'
           AND se1.E1_FILIAL = '01'
           AND se1.E1_SALDO > 0
           AND CONVERT(date, se1.E1_VENCREA, 112) <= CONVERT(date, GETDATE())
           AND se1.E1_EMISSAO BETWEEN @ini AND @fim
           AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
           ${condBuInad}
         GROUP BY SUBSTRING(se1.E1_EMISSAO, 1, 6)
         ORDER BY ymes`,
        sqlParams
      );

      // Junta as duas series por ymes
      const map = new Map();
      const ymeses = new Set();
      fatRows.forEach(r => {
        const k = trim(r.ymes);
        ymeses.add(k);
        if (!map.has(k)) map.set(k, { ymes: k, faturado: 0, inadimplencia: 0, qtdTitulos: 0 });
        map.get(k).faturado = toN(r.faturado);
      });
      inadRows.forEach(r => {
        const k = trim(r.ymes);
        ymeses.add(k);
        if (!map.has(k)) map.set(k, { ymes: k, faturado: 0, inadimplencia: 0, qtdTitulos: 0 });
        map.get(k).inadimplencia = toN(r.saldoVencido);
        map.get(k).qtdTitulos = toN(r.qtdTitulos);
      });

      const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
      const serie = [...ymeses].sort().map(k => {
        const m = map.get(k);
        const ano = k.slice(0, 4);
        const mes = Number(k.slice(4, 6));
        const pct = m.faturado > 0 ? (m.inadimplencia / m.faturado) * 100 : 0;
        return {
          ymes: k,
          ano, mes,
          label: `${meses[mes - 1]}/${ano.slice(2)}`,
          faturado: Number(m.faturado.toFixed(2)),
          inadimplencia: Number(m.inadimplencia.toFixed(2)),
          qtdTitulos: m.qtdTitulos,
          pctInadimplencia: Number(pct.toFixed(2))
        };
      });

      // Totais consolidados do periodo
      const totFat = serie.reduce((s, x) => s + x.faturado, 0);
      const totInad = serie.reduce((s, x) => s + x.inadimplencia, 0);
      const pctAtual = totFat > 0 ? (totInad / totFat) * 100 : 0;

      // ============== Analise de "como baixar o indice" ==============
      // Meta default 6% — operador pode passar ?metaPct=N pra customizar.
      const metaPct = Number(req.query.metaPct) || 6;
      // Valor de inadimplencia tolerado pra atingir a meta:
      //   inadAlvo = totFat * (metaPct/100)
      //   excesso  = max(0, totInad - inadAlvo)  -> precisa "limpar" excesso pra bater meta
      const inadAlvo = totFat * (metaPct / 100);
      const excessoParaMeta = Math.max(0, totInad - inadAlvo);

      // Top 15 clientes contribuindo pra inadimplencia (mesmo universo: titulos
      // vencidos, saldo > 0, mesma janela de emissao). Ajuda o operador a focar
      // esforco — pareto puro.
      const topClientes = await Protheus.connectAndQuery(`
        SELECT TOP 15
               RTRIM(se1.E1_CLIENTE) cod,
               RTRIM(se1.E1_LOJA)    loja,
               RTRIM(COALESCE(NULLIF(sa1.A1_NOME, ''), se1.E1_NOMCLI)) nome,
               RTRIM(sa1.A1_EST) uf,
               SUM(se1.E1_SALDO) saldo,
               COUNT(*) qtd,
               MAX(DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE())) maiorAtraso
          FROM SE1010 se1 WITH (NOLOCK)
          LEFT JOIN SA1010 sa1 WITH (NOLOCK)
            ON sa1.A1_COD = se1.E1_CLIENTE AND sa1.A1_LOJA = se1.E1_LOJA
           AND sa1.D_E_L_E_T_ <> '*'
          ${joinSc5Inad}
         WHERE se1.D_E_L_E_T_ <> '*'
           AND se1.E1_FILIAL = '01'
           AND se1.E1_SALDO > 0
           AND CONVERT(date, se1.E1_VENCREA, 112) <= CONVERT(date, GETDATE())
           AND se1.E1_EMISSAO BETWEEN @ini AND @fim
           AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
           ${condBuInad}
         GROUP BY se1.E1_CLIENTE, se1.E1_LOJA, sa1.A1_NOME, se1.E1_NOMCLI, sa1.A1_EST
         ORDER BY SUM(se1.E1_SALDO) DESC`,
        sqlParams
      );

      // Distribuicao por aging (faixa de atraso) — onde concentrar acao
      const agingRows = await Protheus.connectAndQuery(`
        SELECT
          CASE
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) <= 30  THEN 'A_1_30'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) <= 60  THEN 'B_31_60'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) <= 90  THEN 'C_61_90'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) <= 180 THEN 'D_91_180'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) <= 365 THEN 'E_181_365'
            ELSE 'F_365_MAIS'
          END faixa,
          SUM(se1.E1_SALDO) saldo,
          COUNT(*) qtd
          FROM SE1010 se1 WITH (NOLOCK)
          ${joinSc5Inad}
         WHERE se1.D_E_L_E_T_ <> '*'
           AND se1.E1_FILIAL = '01'
           AND se1.E1_SALDO > 0
           AND CONVERT(date, se1.E1_VENCREA, 112) <= CONVERT(date, GETDATE())
           AND se1.E1_EMISSAO BETWEEN @ini AND @fim
           AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
           ${condBuInad}
         GROUP BY
          CASE
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) <= 30  THEN 'A_1_30'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) <= 60  THEN 'B_31_60'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) <= 90  THEN 'C_61_90'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) <= 180 THEN 'D_91_180'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) <= 365 THEN 'E_181_365'
            ELSE 'F_365_MAIS'
          END`,
        sqlParams
      );
      const FAIXAS_LABEL = {
        A_1_30:    '1-30 dias',
        B_31_60:   '31-60 dias',
        C_61_90:   '61-90 dias',
        D_91_180:  '91-180 dias',
        E_181_365: '181-365 dias',
        F_365_MAIS:'>365 dias'
      };
      const aging = agingRows
        .map(r => ({
          faixa: trim(r.faixa),
          label: FAIXAS_LABEL[trim(r.faixa)] || trim(r.faixa),
          saldo: Number(toN(r.saldo).toFixed(2)),
          qtd: toN(r.qtd),
          pct_da_inadimplencia: totInad > 0 ? Number(((toN(r.saldo) / totInad) * 100).toFixed(2)) : 0
        }))
        .sort((a, b) => a.faixa.localeCompare(b.faixa));

      // Top equipes contribuindo (sem filtro de equipe — pra ver onde focar)
      let topEquipes = [];
      if (!equipe) {
        try {
          const buEqRows = await Pg.connectAndQuery(
            `SELECT bu_codigo, equipe FROM tab_cobranca_bu_equipe`, {}
          );
          const mapBuEquipe = new Map();
          buEqRows.forEach(r => mapBuEquipe.set(trim(r.bu_codigo), trim(r.equipe)));

          const inadEqRows = await Protheus.connectAndQuery(`
            SELECT COALESCE(NULLIF(RTRIM(bu_sx5.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO) + ' (Desconhecido)') buLabel,
                   SUM(se1.E1_SALDO) saldo, COUNT(*) qtd
              FROM SE1010 se1 WITH (NOLOCK)
              LEFT JOIN SC5010 sc5 WITH (NOLOCK)
                ON sc5.C5_FILIAL = se1.E1_FILIAL AND sc5.C5_NUM = se1.E1_PEDIDO
               AND sc5.D_E_L_E_T_ <> '*'
              LEFT JOIN SX5010 bu_sx5 WITH (NOLOCK)
                ON bu_sx5.X5_FILIAL = '  ' AND bu_sx5.X5_TABELA = 'Z1'
               AND RTRIM(bu_sx5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO)
               AND bu_sx5.D_E_L_E_T_ <> '*'
             WHERE se1.D_E_L_E_T_ <> '*' AND se1.E1_FILIAL = '01'
               AND se1.E1_SALDO > 0
               AND CONVERT(date, se1.E1_VENCREA, 112) <= CONVERT(date, GETDATE())
               AND se1.E1_EMISSAO BETWEEN @ini AND @fim
               AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
             GROUP BY COALESCE(NULLIF(RTRIM(bu_sx5.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO) + ' (Desconhecido)')`,
            { ini: inicioStr, fim: fimStr }
          );
          const porEq = new Map();
          inadEqRows.forEach(r => {
            const buLabel = trim(r.buLabel);
            const eq = mapBuEquipe.get(buLabel) || 'Sem equipe';
            if (!porEq.has(eq)) porEq.set(eq, { equipe: eq, saldo: 0, qtd: 0 });
            const e = porEq.get(eq);
            e.saldo += toN(r.saldo);
            e.qtd   += toN(r.qtd);
          });
          topEquipes = [...porEq.values()]
            .map(e => ({
              equipe: e.equipe,
              saldo: Number(e.saldo.toFixed(2)),
              qtd: e.qtd,
              pct_da_inadimplencia: totInad > 0 ? Number(((e.saldo / totInad) * 100).toFixed(2)) : 0
            }))
            .sort((a, b) => b.saldo - a.saldo);
        } catch (e) {
          console.warn('fat-vs-inad topEquipes:', e.message);
        }
      }

      // Recomendacoes textuais (heuristica simples)
      const recomendacoes = [];
      if (pctAtual > metaPct) {
        recomendacoes.push(
          `Reduzir inadimplencia em R$ ${excessoParaMeta.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pra atingir meta de ${metaPct}%.`
        );
        const top3 = topClientes.slice(0, 3);
        if (top3.length) {
          const soma3 = top3.reduce((s, c) => s + toN(c.saldo), 0);
          const pctTop3 = totInad > 0 ? (soma3 / totInad) * 100 : 0;
          recomendacoes.push(
            `Os 3 maiores clientes inadimplentes concentram R$ ${soma3.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${pctTop3.toFixed(1)}% do total) — focar acao neles tem maior alavancagem.`
          );
        }
        const longoPrazo = aging.filter(a => ['D_91_180', 'E_181_365', 'F_365_MAIS'].includes(a.faixa))
          .reduce((s, a) => s + a.saldo, 0);
        const pctLongo = totInad > 0 ? (longoPrazo / totInad) * 100 : 0;
        if (pctLongo > 30) {
          recomendacoes.push(
            `${pctLongo.toFixed(1)}% da inadimplencia e de >90 dias (R$ ${longoPrazo.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) — avaliar protesto, juridico ou marcar como PERDA pra "limpar" a base.`
          );
        }
        if (topEquipes.length > 0) {
          const t1 = topEquipes[0];
          if (t1.pct_da_inadimplencia > 30) {
            recomendacoes.push(
              `Equipe "${t1.equipe}" responde por ${t1.pct_da_inadimplencia}% da inadimplencia — alinhar processo de cobranca/credito com essa equipe.`
            );
          }
        }
      } else {
        const folga = inadAlvo - totInad;
        recomendacoes.push(
          `Inadimplencia esta DENTRO da meta de ${metaPct}%. Folga de R$ ${folga.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} antes de atingir o limite.`
        );
      }

      return res.json({
        periodo: { anoMin, anoMax },
        equipe: equipe || null,
        meta: {
          pct: metaPct,
          inadimplencia_alvo: Number(inadAlvo.toFixed(2)),
          excesso_para_meta: Number(excessoParaMeta.toFixed(2)),
          dentro_da_meta: pctAtual <= metaPct,
          delta_pp: Number((pctAtual - metaPct).toFixed(2))   // pontos percentuais acima/abaixo da meta
        },
        totais: {
          faturado: Number(totFat.toFixed(2)),
          inadimplencia: Number(totInad.toFixed(2)),
          pctInadimplencia: Number(pctAtual.toFixed(2))
        },
        serie,
        analise: {
          top_clientes: topClientes.map(c => ({
            cod: trim(c.cod), loja: trim(c.loja), nome: trim(c.nome),
            uf: trim(c.uf), saldo: Number(toN(c.saldo).toFixed(2)),
            qtd: toN(c.qtd), maior_atraso: toN(c.maiorAtraso),
            pct_da_inadimplencia: totInad > 0 ? Number(((toN(c.saldo) / totInad) * 100).toFixed(2)) : 0
          })),
          aging,
          top_equipes: topEquipes,
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

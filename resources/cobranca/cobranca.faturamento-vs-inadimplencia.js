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

// Consolidacao de BUs no drill-down (regra de negocio 20/08): CIOSP (qualquer
// ediçao) e FRANQUEADO REPRESENTAÇÃO contam como "Comercial Varejo".
const canonBu = (label) => {
  const L = String(label || '').trim();
  if (!L) return '';
  if (/^CIOSP\b/i.test(L)) return 'Comercial Varejo';
  if (L.toUpperCase() === 'FRANQUEADO REPRESENTAÇÃO') return 'Comercial Varejo';
  return L;
};

// E1_FORMAPG nao tem cBox/SX5 (mesmo mapa do painel de cobranca).
const FORMAS_PGTO = {
  '1': 'Cheque', '2': 'Dinheiro', '3': 'Cartao', '4': 'Boleto Bancario',
  '5': 'Nao informado', '6': 'Financiamento', '7': 'Cartao BNDS', '8': 'Bonificacao',
  '9': 'Consignado', 'B': 'Antecipacao Parcelada', 'A': 'Futuro Garantido', '': 'Nao informado'
};

// CFOPs de venda (p/ o faturamento do periodo, usado no Prazo Medio de Recebimento).
const CFOPS_VENDA = [
  '5101','5102','5103','5104','5105','5106','5109','5110','5111','5112','5113','5114','5115','5116','5117','5118','5119','5120','5122','5123','5129',
  '5251','5252','5253','5254','5255','5256','5257','5258','5301','5302','5303','5304','5305','5306','5307','5351','5352','5353','5354','5355','5356','5357','5359','5360',
  '5401','5402','5403','5405','5651','5652','5653','5654','5655','5656','5667','5932','5933',
  '6101','6102','6103','6104','6105','6106','6107','6108','6109','6110','6111','6112','6113','6114','6115','6116','6117','6118','6119','6120','6122','6123','6129',
  '6251','6252','6253','6254','6255','6256','6257','6258','6301','6302','6303','6304','6305','6306','6307','6351','6352','6353','6354','6355','6356','6357','6359','6360',
  '6401','6402','6403','6404','6651','6652','6653','6654','6655','6656','6667','6932','6933',
  '7101','7102','7105','7106','7127','7129','7251','7301','7358','7651','7654','7667'
];

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

    // Forma de pagamento: a serie/faturamento ja respeitam via fi (E1_FORMAPG/C5_FORMAPG).
    // topClientes/aging/porEquipe usam condBuInad, entao aplicamos condForma neles (mesmo @forma).
    const formaSel = trim(req.query.formaPgto);
    const condForma = formaSel ? `AND RTRIM(se1.E1_FORMAPG) = @forma` : '';

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

      // Prazo Medio de Recebimento (DSO) = contas a receber / (faturamento do periodo / dias).
      // Faturamento = NF de saida (SF2/SD2, CFOPs de venda) do mesmo periodo/filtros.
      let totFat = 0;
      try {
        const cfopList = CFOPS_VENDA.map(c => `'${c}'`).join(',');
        const fatRows = await Protheus.connectAndQuery(`
          SELECT SUM(sd2.D2_VALBRUT) faturado
            FROM SF2010 sf2 WITH (NOLOCK)
            INNER JOIN SD2010 sd2 WITH (NOLOCK)
              ON sd2.D2_FILIAL = sf2.F2_FILIAL AND sd2.D2_DOC = sf2.F2_DOC
             AND sd2.D2_SERIE = sf2.F2_SERIE AND sd2.D2_CLIENTE = sf2.F2_CLIENTE
             AND sd2.D2_LOJA = sf2.F2_LOJA AND sd2.D_E_L_E_T_ <> '*'
             AND sd2.D2_CF IN (${cfopList})
            ${fi.fatJoins}
           WHERE sf2.D_E_L_E_T_ <> '*' AND sf2.F2_FILIAL = '01'
             AND sf2.F2_EMISSAO BETWEEN @ini AND @fim
             ${fi.fatWhere}
             ${excluiSql('sf2.F2_CLIENTE', 'sf2.F2_LOJA')}`,
          sqlParams);
        totFat = toN(fatRows[0]?.faturado);
      } catch (e) { console.warn('fat-vs-inad faturamento(PMR):', e.message); }
      const iniDate = new Date(anoMin, 0, 1).getTime();
      const fimDate = Math.min(Date.now(), new Date(anoMax, 11, 31).getTime());
      const diasPeriodo = Math.max(1, Math.round((fimDate - iniDate) / 86400000));
      const pmr = totFat > 0 ? (totCR / totFat) * diasPeriodo : 0;

      // Formas de pagamento disponiveis (pra o dropdown) — universo de contas a
      // receber do periodo (independente da forma selecionada, pra a lista nao sumir).
      let formasDisponiveis = [];
      try {
        const fRows = await Protheus.connectAndQuery(`
          SELECT RTRIM(se1.E1_FORMAPG) cod, COUNT(*) qtd, SUM(se1.E1_SALDO) saldo
            FROM SE1010 se1 WITH (NOLOCK)
           WHERE se1.D_E_L_E_T_ <> '*' AND se1.E1_FILIAL = '01'
             AND se1.E1_SALDO > 0
             AND se1.E1_EMISSAO BETWEEN @ini AND @fim
             AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
             ${excluiSql('se1.E1_CLIENTE', 'se1.E1_LOJA')}
           GROUP BY RTRIM(se1.E1_FORMAPG)
           ORDER BY SUM(se1.E1_SALDO) DESC`,
          { ini: inicioStr, fim: fimStr });
        formasDisponiveis = fRows.map(r => ({
          cod: trim(r.cod),
          nome: FORMAS_PGTO[trim(r.cod)] || `Forma ${trim(r.cod)}`,
          qtd: toN(r.qtd), saldo: Number(toN(r.saldo).toFixed(2))
        }));
      } catch (e) { console.warn('fat-vs-inad formas:', e.message); }

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
           ${condForma}
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
           ${condForma}
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
             ${condForma}
             ${excluiSql('se1.E1_CLIENTE', 'se1.E1_LOJA')}
           GROUP BY ${BU_EXPR}`,
          sqlParams
        );
        const bc = {
          B2C: { equipe: 'B2C', saldo: 0, qtd: 0, bus: new Map() },
          B2B: { equipe: 'B2B', saldo: 0, qtd: 0, bus: new Map() }
        };
        inadBuRows.forEach(r => {
          // Canonicaliza a BU (CIOSP/FRANQUEADO REPRESENTAÇÃO -> Comercial Varejo) e
          // classifica pela equipe da BU JA canonicalizada, pra a linha e o B2B/B2C baterem.
          const buLabel = canonBu(r.buLabel) || '(sem BU)';
          const eq = mapBuEquipe.get(buLabel) || mapBuEquipe.get(trim(r.buLabel)) || 'Sem equipe';
          const cat = setB2C.has(eq) ? 'B2C' : 'B2B';
          const saldo = toN(r.saldo), qtd = toN(r.qtd);
          bc[cat].saldo += saldo; bc[cat].qtd += qtd;
          const cur = bc[cat].bus.get(buLabel) || { bu: buLabel, saldo: 0, qtd: 0 };
          cur.saldo += saldo; cur.qtd += qtd;
          bc[cat].bus.set(buLabel, cur);
        });
        porEquipe = [bc.B2C, bc.B2B]
          .filter(e => e.saldo > 0 || e.qtd > 0)
          .map(e => ({
            equipe: e.equipe, saldo: Number(e.saldo.toFixed(2)), qtd: e.qtd,
            pct_da_inadimplencia: totInad > 0 ? Number(((e.saldo / totInad) * 100).toFixed(2)) : 0,
            // Granularidade: quanto cada BU representa DENTRO da equipe.
            bus: Array.from(e.bus.values())
              .filter(b => b.saldo > 0 || b.qtd > 0)
              .map(b => ({
                bu: b.bu, saldo: Number(b.saldo.toFixed(2)), qtd: b.qtd,
                pct_da_equipe: e.saldo > 0 ? Number(((b.saldo / e.saldo) * 100).toFixed(2)) : 0
              }))
              .sort((a, b) => b.saldo - a.saldo)
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
        formaPgto: formaSel || null,
        formas_pgto_disponiveis: formasDisponiveis,
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
          ticketMedio: Number(ticketMedio.toFixed(2)),
          prazoMedioRecebimento: Number(pmr.toFixed(1)),   // dias (DSO)
          faturamentoPeriodo: Number(totFat.toFixed(2))
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

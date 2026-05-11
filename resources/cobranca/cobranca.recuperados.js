// GET /cobranca/recuperados?mesIni=YYYYMM&mesFim=YYYYMM&diasAtrasoMin=4&equipe=&formaPgto=
//
// "Recuperado" = titulo que foi PAGO em ATRASO (E1_BAIXA > E1_VENCREA + 3 dias)
// no periodo de baixa. Considera todas as formas de pagamento.
//
// Por que +3 dias? O usuario definiu: "acima de D+3" — alinhado com o critério
// dos disparos automaticos de WhatsApp (D+3 e o ultimo lembrete). Antes disso,
// o cliente esta em "carencia" e nao conta como recuperacao.
//
// Filtros:
//   - mesIni / mesFim  YYYYMM (default: ultimos 12 meses ate o mes atual)
//   - diasAtrasoMin    int (default 4 = > D+3)
//   - equipe           string (filtra via SC5.C5_ZTIPO -> tab_cobranca_bu_equipe)
//   - formaPgto        codigo de E1_FORMAPG (1-9, A, B)
//
// Retorna:
//   - kpis (total recuperado, qtd titulos, % recuperacao, atraso medio)
//   - serie mensal (recuperado_mes vs em_aberto_vencido_mes)
//   - por_faixa_atraso, por_forma_pgto
//   - top_clientes, por_equipe
//   - tempo_medio_recuperacao por aging

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

// Mesma tabela de formas de pgto usada no painel/whatsapp
const FORMAS_PGTO = {
  '1':'Cheque','2':'Dinheiro','3':'Cartão','4':'Boleto Bancário','5':'Não informado',
  '6':'Financiamento','7':'Cartão BNDS','8':'Bonificação','9':'Consignado',
  'B':'Antecipação Parcelada','A':'Futuro Garantido',
  '': 'Não informado'
};
const descreverFormaPgto = (cod) => FORMAS_PGTO[cod] || `Forma ${cod}`;

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001]);

module.exports = (app) => ({
  verb: 'get',
  route: '/recuperados',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;

    // ===== Periodo (default 12 meses ate hoje) =====
    const hoje = new Date();
    const mesAtualYM = `${hoje.getFullYear()}${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const mesIni12m = new Date(hoje.getFullYear(), hoje.getMonth() - 11, 1);
    const ymDefaultIni = `${mesIni12m.getFullYear()}${String(mesIni12m.getMonth() + 1).padStart(2, '0')}`;

    const mesIniRaw = /^\d{6}$/.test(req.query.mesIni) ? String(req.query.mesIni) : ymDefaultIni;
    const mesFimRaw = /^\d{6}$/.test(req.query.mesFim) ? String(req.query.mesFim) : mesAtualYM;
    if (mesIniRaw > mesFimRaw) {
      return res.status(400).json({ message: 'mesIni nao pode ser maior que mesFim.' });
    }
    // Datas Protheus YYYYMMDD
    const inicioStr = `${mesIniRaw}01`;
    const ultimoDiaFim = new Date(Number(mesFimRaw.slice(0, 4)), Number(mesFimRaw.slice(4, 6)), 0).getDate();
    const fimStr = `${mesFimRaw}${String(ultimoDiaFim).padStart(2, '0')}`;

    const diasAtrasoMin = Math.max(1, Number(req.query.diasAtrasoMin) || 4);  // > D+3 = 4 dias
    const equipe = trim(req.query.equipe);
    const formaPgto = trim(req.query.formaPgto);

    // ===== Filtro de equipe (resolve via tab_cobranca_bu_equipe) =====
    const condParts = [];
    const sqlParams = { ini: inicioStr, fim: fimStr, atrasoMin: diasAtrasoMin };

    let joinSc5 = '';
    if (equipe) {
      try {
        const buEqRows = await Pg.connectAndQuery(
          `SELECT bu_codigo FROM tab_cobranca_bu_equipe WHERE equipe = @eq`,
          { eq: equipe }
        );
        const buLabels = buEqRows.map(r => trim(r.bu_codigo)).filter(Boolean);
        if (buLabels.length === 0) {
          // Equipe sem BUs cadastradas — retorna vazio
          return res.json({
            periodo: { mesIni: mesIniRaw, mesFim: mesFimRaw },
            equipe, formaPgto: formaPgto || null, diasAtrasoMin,
            kpis: { recuperado: 0, qtd_titulos: 0, pct_recuperacao: 0, atraso_medio_dias: 0, em_aberto_vencido: 0 },
            serie: [], por_faixa_atraso: [], por_forma_pgto: [], top_clientes: [], por_equipe: []
          });
        }
        const inLabels = buLabels.map((_, i) => `@bu${i}`).join(',');
        buLabels.forEach((b, i) => { sqlParams[`bu${i}`] = b; });
        joinSc5 = `LEFT JOIN SC5010 sc5 WITH (NOLOCK) ON sc5.C5_FILIAL = se1.E1_FILIAL AND sc5.C5_NUM = se1.E1_PEDIDO AND sc5.D_E_L_E_T_ <> '*'
                   LEFT JOIN SX5010 bu_sx5 WITH (NOLOCK) ON bu_sx5.X5_FILIAL = '  ' AND bu_sx5.X5_TABELA = 'Z1' AND RTRIM(bu_sx5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND bu_sx5.D_E_L_E_T_ <> '*'`;
        condParts.push(`AND COALESCE(NULLIF(RTRIM(bu_sx5.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO) + ' (Desconhecido)') IN (${inLabels})`);
      } catch (e) {
        console.warn('recuperados: equipe lookup falhou', e.message);
      }
    }
    if (formaPgto) {
      sqlParams.forma = formaPgto;
      condParts.push(`AND RTRIM(se1.E1_FORMAPG) = @forma`);
    }

    // ===== Base WHERE comum: titulos baixados (E1_BAIXA preenchido)
    // no periodo, com atraso na baixa > diasAtrasoMin =====
    const whereBase = `
      WHERE se1.D_E_L_E_T_ <> '*'
        AND se1.E1_FILIAL = '01'
        AND RTRIM(se1.E1_TIPO) NOT IN ('RA', 'NCC')
        AND RTRIM(se1.E1_BAIXA) <> ''
        AND ISDATE(se1.E1_BAIXA) = 1
        AND ISDATE(se1.E1_VENCREA) = 1
        AND CONVERT(date, se1.E1_BAIXA, 112) BETWEEN CONVERT(date, @ini, 112) AND CONVERT(date, @fim, 112)
        AND DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) >= @atrasoMin
        ${condParts.join(' ')}`;

    try {
      // ===== 1) KPIs gerais =====
      const kpiRows = await Protheus.connectAndQuery(`
        SELECT
          SUM(se1.E1_VALOR) total_recuperado,
          COUNT(*) qtd_titulos,
          AVG(CAST(DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) AS float)) atraso_medio
          FROM SE1010 se1 WITH (NOLOCK)
          ${joinSc5}
          ${whereBase}`, sqlParams);
      const recuperado = toN(kpiRows[0]?.total_recuperado);
      const qtdTitulos = toN(kpiRows[0]?.qtd_titulos);
      const atrasoMedio = Number(toN(kpiRows[0]?.atraso_medio).toFixed(1));

      // ===== Em aberto vencido no MESMO periodo (denominador da % de recuperacao)
      // = titulos com E1_VENCREA dentro do periodo, vencidos antes de hoje, ainda em aberto
      const emAbertoRows = await Protheus.connectAndQuery(`
        SELECT SUM(se1.E1_SALDO) em_aberto_vencido, COUNT(*) qt_em_aberto
          FROM SE1010 se1 WITH (NOLOCK)
          ${joinSc5}
         WHERE se1.D_E_L_E_T_ <> '*'
           AND se1.E1_FILIAL = '01'
           AND se1.E1_SALDO > 0
           AND RTRIM(se1.E1_TIPO) NOT IN ('RA', 'NCC')
           AND ISDATE(se1.E1_VENCREA) = 1
           AND CONVERT(date, se1.E1_VENCREA, 112) <= CONVERT(date, GETDATE())
           AND CONVERT(date, se1.E1_VENCREA, 112) BETWEEN CONVERT(date, @ini, 112) AND CONVERT(date, @fim, 112)
           ${condParts.join(' ')}`, sqlParams);
      const emAbertoVencido = toN(emAbertoRows[0]?.em_aberto_vencido);

      const totalUniverso = recuperado + emAbertoVencido;
      const pctRecuperacao = totalUniverso > 0 ? (recuperado / totalUniverso) * 100 : 0;

      // ===== 2) Serie mensal (recuperado por mes de baixa) =====
      const serieRows = await Protheus.connectAndQuery(`
        SELECT
          SUBSTRING(se1.E1_BAIXA, 1, 6) ymes,
          SUM(se1.E1_VALOR) recuperado,
          COUNT(*) qtd,
          AVG(CAST(DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) AS float)) atraso_medio
          FROM SE1010 se1 WITH (NOLOCK)
          ${joinSc5}
          ${whereBase}
         GROUP BY SUBSTRING(se1.E1_BAIXA, 1, 6)
         ORDER BY ymes`, sqlParams);
      const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
      const serie = serieRows.map(r => {
        const ym = trim(r.ymes);
        const ano = ym.slice(0, 4), mes = Number(ym.slice(4, 6));
        return {
          ymes: ym,
          label: `${meses[mes - 1]}/${ano.slice(2)}`,
          recuperado: Number(toN(r.recuperado).toFixed(2)),
          qtd: toN(r.qtd),
          atraso_medio_dias: Number(toN(r.atraso_medio).toFixed(1))
        };
      });

      // ===== 3) Por faixa de atraso na baixa =====
      const faixaRows = await Protheus.connectAndQuery(`
        SELECT
          CASE
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) <= 30  THEN 'A_4_30'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) <= 60  THEN 'B_31_60'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) <= 90  THEN 'C_61_90'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) <= 180 THEN 'D_91_180'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) <= 365 THEN 'E_181_365'
            ELSE 'F_365_MAIS'
          END faixa,
          SUM(se1.E1_VALOR) valor,
          COUNT(*) qtd
          FROM SE1010 se1 WITH (NOLOCK)
          ${joinSc5}
          ${whereBase}
         GROUP BY
          CASE
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) <= 30  THEN 'A_4_30'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) <= 60  THEN 'B_31_60'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) <= 90  THEN 'C_61_90'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) <= 180 THEN 'D_91_180'
            WHEN DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) <= 365 THEN 'E_181_365'
            ELSE 'F_365_MAIS'
          END`, sqlParams);
      const FAIXAS_LABEL = {
        A_4_30: '4-30 dias', B_31_60: '31-60 dias', C_61_90: '61-90 dias',
        D_91_180: '91-180 dias', E_181_365: '181-365 dias', F_365_MAIS: '>365 dias'
      };
      const por_faixa_atraso = faixaRows
        .map(r => ({
          faixa: trim(r.faixa),
          label: FAIXAS_LABEL[trim(r.faixa)] || trim(r.faixa),
          valor: Number(toN(r.valor).toFixed(2)),
          qtd: toN(r.qtd),
          pct: recuperado > 0 ? Number(((toN(r.valor) / recuperado) * 100).toFixed(2)) : 0
        }))
        .sort((a, b) => a.faixa.localeCompare(b.faixa));

      // ===== 4) Por forma de pagamento =====
      const formaRows = await Protheus.connectAndQuery(`
        SELECT RTRIM(se1.E1_FORMAPG) forma, SUM(se1.E1_VALOR) valor, COUNT(*) qtd
          FROM SE1010 se1 WITH (NOLOCK)
          ${joinSc5}
          ${whereBase}
         GROUP BY RTRIM(se1.E1_FORMAPG)
         ORDER BY SUM(se1.E1_VALOR) DESC`, sqlParams);
      const por_forma_pgto = formaRows.map(r => ({
        cod: trim(r.forma),
        nome: descreverFormaPgto(trim(r.forma)),
        valor: Number(toN(r.valor).toFixed(2)),
        qtd: toN(r.qtd),
        pct: recuperado > 0 ? Number(((toN(r.valor) / recuperado) * 100).toFixed(2)) : 0
      }));

      // ===== 5) Top 15 clientes recuperados =====
      const topClientes = await Protheus.connectAndQuery(`
        SELECT TOP 15
          RTRIM(se1.E1_CLIENTE) cod, RTRIM(se1.E1_LOJA) loja,
          RTRIM(COALESCE(NULLIF(sa1.A1_NOME, ''), se1.E1_NOMCLI)) nome,
          RTRIM(sa1.A1_EST) uf,
          SUM(se1.E1_VALOR) valor, COUNT(*) qtd,
          AVG(CAST(DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) AS float)) atraso_medio
          FROM SE1010 se1 WITH (NOLOCK)
          LEFT JOIN SA1010 sa1 WITH (NOLOCK)
            ON sa1.A1_COD = se1.E1_CLIENTE AND sa1.A1_LOJA = se1.E1_LOJA
           AND sa1.D_E_L_E_T_ <> '*'
          ${joinSc5}
          ${whereBase}
         GROUP BY se1.E1_CLIENTE, se1.E1_LOJA, sa1.A1_NOME, se1.E1_NOMCLI, sa1.A1_EST
         ORDER BY SUM(se1.E1_VALOR) DESC`, sqlParams);
      const top_clientes = topClientes.map(c => ({
        cod: trim(c.cod), loja: trim(c.loja), nome: trim(c.nome), uf: trim(c.uf),
        valor: Number(toN(c.valor).toFixed(2)), qtd: toN(c.qtd),
        atraso_medio_dias: Number(toN(c.atraso_medio).toFixed(1)),
        pct: recuperado > 0 ? Number(((toN(c.valor) / recuperado) * 100).toFixed(2)) : 0
      }));

      // ===== 6) Por equipe (so se nao filtrou equipe) =====
      let por_equipe = [];
      if (!equipe) {
        try {
          const buEqRows = await Pg.connectAndQuery(`SELECT bu_codigo, equipe FROM tab_cobranca_bu_equipe`, {});
          const mapBuEquipe = new Map();
          buEqRows.forEach(r => mapBuEquipe.set(trim(r.bu_codigo), trim(r.equipe)));

          const eqRows = await Protheus.connectAndQuery(`
            SELECT COALESCE(NULLIF(RTRIM(bu_sx5.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO) + ' (Desconhecido)') buLabel,
                   SUM(se1.E1_VALOR) valor, COUNT(*) qtd
              FROM SE1010 se1 WITH (NOLOCK)
              LEFT JOIN SC5010 sc5 WITH (NOLOCK)
                ON sc5.C5_FILIAL = se1.E1_FILIAL AND sc5.C5_NUM = se1.E1_PEDIDO AND sc5.D_E_L_E_T_ <> '*'
              LEFT JOIN SX5010 bu_sx5 WITH (NOLOCK)
                ON bu_sx5.X5_FILIAL = '  ' AND bu_sx5.X5_TABELA = 'Z1'
               AND RTRIM(bu_sx5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND bu_sx5.D_E_L_E_T_ <> '*'
             WHERE se1.D_E_L_E_T_ <> '*' AND se1.E1_FILIAL = '01'
               AND RTRIM(se1.E1_TIPO) NOT IN ('RA', 'NCC')
               AND RTRIM(se1.E1_BAIXA) <> '' AND ISDATE(se1.E1_BAIXA) = 1 AND ISDATE(se1.E1_VENCREA) = 1
               AND CONVERT(date, se1.E1_BAIXA, 112) BETWEEN CONVERT(date, @ini, 112) AND CONVERT(date, @fim, 112)
               AND DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) >= @atrasoMin
             GROUP BY COALESCE(NULLIF(RTRIM(bu_sx5.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO) + ' (Desconhecido)')`,
            { ini: inicioStr, fim: fimStr, atrasoMin: diasAtrasoMin });

          const porEq = new Map();
          eqRows.forEach(r => {
            const bu = trim(r.buLabel);
            const eq = mapBuEquipe.get(bu) || 'Sem equipe';
            if (!porEq.has(eq)) porEq.set(eq, { equipe: eq, valor: 0, qtd: 0 });
            const e = porEq.get(eq);
            e.valor += toN(r.valor); e.qtd += toN(r.qtd);
          });
          por_equipe = [...porEq.values()]
            .map(e => ({
              equipe: e.equipe,
              valor: Number(e.valor.toFixed(2)),
              qtd: e.qtd,
              pct: recuperado > 0 ? Number(((e.valor / recuperado) * 100).toFixed(2)) : 0
            }))
            .sort((a, b) => b.valor - a.valor);
        } catch (e) {
          console.warn('recuperados por_equipe:', e.message);
        }
      }

      return res.json({
        periodo: { mesIni: mesIniRaw, mesFim: mesFimRaw },
        equipe: equipe || null,
        formaPgto: formaPgto || null,
        diasAtrasoMin,
        kpis: {
          recuperado: Number(recuperado.toFixed(2)),
          qtd_titulos: qtdTitulos,
          em_aberto_vencido: Number(emAbertoVencido.toFixed(2)),
          pct_recuperacao: Number(pctRecuperacao.toFixed(2)),
          atraso_medio_dias: atrasoMedio
        },
        serie,
        por_faixa_atraso,
        por_forma_pgto,
        top_clientes,
        por_equipe,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('cobranca/recuperados:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

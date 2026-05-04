// Saidas Diversas — replica os 3 ajax do intranet antigo (ajaxSaidasAcompanhamento,
// ajaxSaidasDiversas, ajaxSaidasDiversasAcm) numa unica chamada.
//
// GET /vendas/saidas-diversas?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&vendedor=000123
//
// Retorna 3 secoes:
//   - acompanhamento: TES de "acompanhar" (538/546/540/559)
//       cada linha tem valorMes (periodo filtrado) + valorAcumulado (todo historico)
//   - diversosMes:    TES de "diversos" (539/543/585/566/595/606/607) no periodo
//   - diversosAcumulado: mesmas TES diversas, sem filtro de inicio (somente <= fim)
//
// Lista de TES vem de tab_vendas_tes_categoria (categoria = 'acompanhar' | 'diversos').

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

const toProtData = (iso) => {
  const s = String(iso || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};

module.exports = (app) => ({
  verb: 'get',
  route: '/saidas-diversas',
  middlewares: [require('../../middlewares/requirePerm')(app)([2003, 2002])],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;

    const inicio = toProtData(req.query.inicio);
    const fim    = toProtData(req.query.fim);
    if (!inicio || !fim) {
      return res.status(400).json({ message: 'Parametros inicio e fim sao obrigatorios (YYYY-MM-DD).' });
    }
    const vendedor = trim(req.query.vendedor);

    try {
      // 1) Carrega categorias TES da tabela de config
      const cats = await Pg.connectAndQuery(
        `SELECT tes, descricao, categoria
           FROM tab_vendas_tes_categoria
          WHERE ativo = true
          ORDER BY categoria, tes`, {}
      );

      const acompanhar = cats.filter(c => c.categoria === 'acompanhar');
      const diversos   = cats.filter(c => c.categoria === 'diversos');

      if (acompanhar.length === 0 && diversos.length === 0) {
        return res.json({
          periodo: { inicio, fim }, vendedor: vendedor || null,
          acompanhamento: [], diversosMes: [], diversosAcumulado: [],
          aviso: 'Nenhuma TES configurada em tab_vendas_tes_categoria.'
        });
      }

      const condVend = vendedor
        ? `AND (sc5.C5_VEND1 = @vend OR sc5.C5_VEND2 = @vend OR sc5.C5_VEND3 = @vend)`
        : '';

      // ============== Helper que executa a query agregada por TES ==============
      // periodoSql: trecho extra de WHERE (datas). Pode ser '' pra acumulado total.
      async function consulta(tesArr, periodoSql, params) {
        if (tesArr.length === 0) return [];
        const inList = tesArr.map((_, i) => `@t${i}`).join(',');
        const p = { ...params };
        tesArr.forEach((t, i) => { p[`t${i}`] = t.tes; });
        if (vendedor) p.vend = vendedor;

        const rows = await Protheus.connectAndQuery(`
          SELECT RTRIM(sc6.C6_TES) tes,
                 SUM(sc6.C6_QTDVEN) qtd,
                 SUM(sc6.C6_VALOR)  total,
                 COUNT(DISTINCT sc5.C5_NUM) numnf
            FROM SC6010 sc6 WITH (NOLOCK)
            LEFT JOIN SC5010 sc5 WITH (NOLOCK) ON sc6.C6_NUM = sc5.C5_NUM
           WHERE sc5.C5_FILIAL = '01'
             AND sc5.D_E_L_E_T_ <> '*'
             AND sc6.D_E_L_E_T_ <> '*'
             AND sc6.C6_BLQ = ' '
             AND RTRIM(sc6.C6_TES) IN (${inList})
             ${periodoSql}
             ${condVend}
           GROUP BY sc6.C6_TES`, p);
        return rows;
      }

      // ============== Acompanhamento (mes + acumulado lado a lado) ==============
      const tesAcom = acompanhar.map(c => c.tes);
      const acompMesRows = await consulta(acompanhar,
        `AND sc5.C5_EMISSAO BETWEEN @inicio AND @fim`,
        { inicio, fim }
      );
      const acompTotRows = await consulta(acompanhar, '', {});  // sem filtro de data

      const mapMes = new Map(acompMesRows.map(r => [trim(r.tes), r]));
      const mapTot = new Map(acompTotRows.map(r => [trim(r.tes), r]));
      let totMes = 0, totAcm = 0, totItens = 0, totNotas = 0;
      const acompanhamento = acompanhar.map(c => {
        const m = mapMes.get(c.tes);
        const t = mapTot.get(c.tes);
        const valorMes = m ? toN(m.total) : 0;
        const valorAcumulado = t ? toN(t.total) : 0;
        const itens = m ? toN(m.qtd) : 0;
        const numnf = m ? toN(m.numnf) : 0;
        totMes  += valorMes;
        totAcm  += valorAcumulado;
        totItens += itens;
        totNotas += numnf;
        return { tes: c.tes, descricao: c.descricao, itens, valorMes, valorAcumulado, numnf };
      });
      const acompanhamentoTotais = { itens: totItens, valorMes: totMes, valorAcumulado: totAcm, numnf: totNotas };

      // ============== Diversos no periodo ==============
      const divMesRows = await consulta(diversos,
        `AND sc5.C5_EMISSAO BETWEEN @inicio AND @fim`,
        { inicio, fim }
      );
      const mapDivMes = new Map(divMesRows.map(r => [trim(r.tes), r]));
      let dmTot = 0, dmIt = 0, dmNf = 0;
      const diversosMes = diversos.map(c => {
        const r = mapDivMes.get(c.tes);
        const total = r ? toN(r.total) : 0;
        const itens = r ? toN(r.qtd) : 0;
        const numnf = r ? toN(r.numnf) : 0;
        dmTot += total; dmIt += itens; dmNf += numnf;
        return { tes: c.tes, descricao: c.descricao, itens, total, numnf };
      });
      const diversosMesTotais = { itens: dmIt, total: dmTot, numnf: dmNf };

      // ============== Diversos acumulado (so <= fim, sem inicio) ==============
      const divAcmRows = await consulta(diversos,
        `AND sc5.C5_EMISSAO <= @fim`,
        { fim }
      );
      const mapDivAcm = new Map(divAcmRows.map(r => [trim(r.tes), r]));
      let daTot = 0, daIt = 0, daNf = 0;
      const diversosAcumulado = diversos.map(c => {
        const r = mapDivAcm.get(c.tes);
        const total = r ? toN(r.total) : 0;
        const itens = r ? toN(r.qtd) : 0;
        const numnf = r ? toN(r.numnf) : 0;
        daTot += total; daIt += itens; daNf += numnf;
        return { tes: c.tes, descricao: c.descricao, itens, total, numnf };
      });
      const diversosAcumuladoTotais = { itens: daIt, total: daTot, numnf: daNf };

      return res.json({
        periodo: { inicio, fim },
        vendedor: vendedor || null,
        acompanhamento, acompanhamentoTotais,
        diversosMes, diversosMesTotais,
        diversosAcumulado, diversosAcumuladoTotais,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro vendas/saidas-diversas:', err);
      return res.status(500).json({ message: 'Erro ao gerar relatorio: ' + err.message });
    }
  }
});

// GET /controladoria/custo/:produto/xlsx — exporta planilha 2-abas (Estrutura + Custo TOTVS)
// no mesmo formato da planilha original do modulo de custos do Protheus.
//
// Aba "Estrutura": estrutura BOM hierarquica (1 linha por componente,
// pai > filhos com nivel/recuo).
// Aba "Custo TOTVS": uma linha por componente direto do PA, com 22 colunas
// (codigos, qtd necessaria, ultima compra, NF, fornecedor, impostos,
// frete, custo bruto e liquido — exatamente como o usuario descreveu).
//
// Formulas de custo unitario seguem o padrao Protheus:
//   bruto unit       = (Total + IPI + ICMS + Frete) / Qtde NF
//   liq unit c/IPI   = (Total + IPI - ICMS - PIS - COFINS) / Qtde NF
//   liq unit         = (Total - ICMS - PIS - COFINS) / Qtde NF

const ExcelJS = require('exceljs');
const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);
const MAX_NIVEL = 5;

// "20240613" -> "13/06/2024"
const fmtData = (ymd) => {
  const s = trim(ymd);
  return s.length === 8 ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : s || '';
};

const safeDiv = (n, d) => (d > 0 ? n / d : 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/custo/:produto/xlsx',

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const produto = trim(req.params.produto).toUpperCase();
    if (!produto) return res.status(400).json({ message: 'Codigo de produto obrigatorio.' });
    const hoje = new Date();
    const hojeYmd = `${hoje.getFullYear()}${String(hoje.getMonth() + 1).padStart(2, '0')}${String(hoje.getDate()).padStart(2, '0')}`;

    try {
      // 1) Cabecalho do produto
      const prod = await Protheus.connectAndQuery(
        `SELECT TOP 1 RTRIM(B1_COD) cod, RTRIM(B1_DESC) descricao, RTRIM(B1_TIPO) tipo, RTRIM(B1_UM) um
           FROM SB1010 WITH (NOLOCK)
          WHERE D_E_L_E_T_ <> '*' AND B1_COD = @produto`, { produto }
      );
      if (!prod.length) return res.status(404).json({ message: 'Produto nao encontrado.' });
      const pa = prod[0];

      // 2) Explosao iterativa SG1 (mesma logica do endpoint /custo)
      const porPai = new Map();
      const todosCods = new Set();
      let paisAtuais = [produto];
      let nivel = 0;

      while (paisAtuais.length && nivel < MAX_NIVEL) {
        const paisUnicos = [...new Set(paisAtuais)].filter(c => !porPai.has(c));
        if (!paisUnicos.length) break;
        const inCods = paisUnicos.map((_, i) => `@pai${i}`).join(',');
        const params = { hoje: hojeYmd };
        paisUnicos.forEach((c, i) => { params[`pai${i}`] = c; });
        const rows = await Protheus.connectAndQuery(
          `SELECT RTRIM(sg1.G1_COD) pai, RTRIM(sg1.G1_COMP) componente,
                  RTRIM(sb1.B1_DESC) descricao, RTRIM(sb1.B1_TIPO) tipo, RTRIM(sb1.B1_UM) um,
                  RTRIM(sb1.B1_GRUPO) grupo,
                  sg1.G1_QUANT qtd, sg1.G1_PERDA perda
             FROM SG1010 sg1 WITH (NOLOCK)
             LEFT JOIN SB1010 sb1 WITH (NOLOCK) ON sb1.B1_COD = sg1.G1_COMP AND sb1.D_E_L_E_T_ <> '*'
            WHERE sg1.D_E_L_E_T_ <> '*'
              AND sg1.G1_COD IN (${inCods})
              AND sg1.G1_INI <= @hoje AND sg1.G1_FIM >= @hoje
            ORDER BY sg1.G1_COD, sg1.G1_COMP`, params);

        const proxPais = [];
        paisUnicos.forEach(p => porPai.set(p, []));
        rows.forEach(r => {
          const item = {
            componente: trim(r.componente), descricao: trim(r.descricao),
            tipo: trim(r.tipo), um: trim(r.um), grupo: trim(r.grupo),
            qtd: toN(r.qtd), perda: toN(r.perda)
          };
          porPai.get(trim(r.pai)).push(item);
          todosCods.add(item.componente);
          if (item.tipo === 'PI' && !porPai.has(item.componente)) proxPais.push(item.componente);
        });
        paisAtuais = proxPais;
        nivel += 1;
      }

      const componentesRaiz = porPai.get(produto) || [];
      if (!componentesRaiz.length) {
        return res.status(404).json({ message: 'Produto sem estrutura SG1 cadastrada para hoje.' });
      }

      // 3) Ultima compra (com pedido + frete) pra cada componente
      const todos = [...todosCods];
      const inTodos = todos.map((_, i) => `@c${i}`).join(',');
      const paramsCompra = {};
      todos.forEach((c, i) => { paramsCompra[`c${i}`] = c; });

      const ultCompra = todos.length ? await Protheus.connectAndQuery(
        `WITH ranked AS (
          SELECT RTRIM(sd1.D1_COD) componente,
                 RTRIM(sd1.D1_DOC) doc, RTRIM(sd1.D1_SERIE) serie,
                 RTRIM(sd1.D1_FORNECE) fornece, RTRIM(sd1.D1_LOJA) loja,
                 RTRIM(sa2.A2_NREDUZ) fornecedorFantasia,
                 RTRIM(sd1.D1_PEDIDO) pedido,
                 sf1.F1_EMISSAO emissao,
                 sd1.D1_QUANT qtdComprada,
                 sd1.D1_VUNIT vunit, sd1.D1_TOTAL total,
                 sd1.D1_VALICM icms, sd1.D1_VALIPI ipi,
                 sd1.D1_VALIMP5 pis, sd1.D1_VALIMP6 cofins,
                 sd1.D1_VALFRE frete,
                 ROW_NUMBER() OVER (PARTITION BY sd1.D1_COD ORDER BY sf1.F1_EMISSAO DESC, sd1.R_E_C_N_O_ DESC) rn
            FROM SD1010 sd1 WITH (NOLOCK)
           INNER JOIN SF1010 sf1 WITH (NOLOCK)
              ON sf1.F1_FILIAL  = sd1.D1_FILIAL
             AND sf1.F1_DOC     = sd1.D1_DOC
             AND sf1.F1_SERIE   = sd1.D1_SERIE
             AND sf1.F1_FORNECE = sd1.D1_FORNECE
             AND sf1.F1_LOJA    = sd1.D1_LOJA
             AND sf1.D_E_L_E_T_ <> '*'
             AND RTRIM(sf1.F1_TIPO) NOT IN ('D')
            LEFT JOIN SA2010 sa2 WITH (NOLOCK)
              ON sa2.A2_COD = sd1.D1_FORNECE AND sa2.A2_LOJA = sd1.D1_LOJA AND sa2.D_E_L_E_T_ <> '*'
           WHERE sd1.D_E_L_E_T_ <> '*'
             AND sd1.D1_COD IN (${inTodos})
             AND sd1.D1_QUANT > 0
        )
        SELECT * FROM ranked WHERE rn = 1`, paramsCompra) : [];

      const mapUlt = new Map();
      ultCompra.forEach(u => mapUlt.set(trim(u.componente), u));

      // 3b) Saldo + custo medio por ARMAZEM (default 21) — base da aba Estrutura.
      // A planilha de referencia le saldo e custo unitario dos componentes do
      // armazem 21 (almoxarifado de MP). Configuravel via ?armazemCusto=NN.
      const armazemCusto = trim(req.query.armazemCusto) || '21';
      const codsB2 = [...new Set([produto, ...todos])];
      const mapB2 = new Map();
      if (codsB2.length) {
        const inB2 = codsB2.map((_, i) => `@b${i}`).join(',');
        const paramsB2 = { arm: armazemCusto };
        codsB2.forEach((c, i) => { paramsB2[`b${i}`] = c; });
        const b2Rows = await Protheus.connectAndQuery(
          `SELECT RTRIM(B2_COD) cod, B2_QATU qatu, B2_CM1 cm1
             FROM SB2010 WITH (NOLOCK)
            WHERE D_E_L_E_T_ <> '*' AND B2_FILIAL = '01' AND RTRIM(B2_LOCAL) = @arm
              AND RTRIM(B2_COD) IN (${inB2})`, paramsB2);
        b2Rows.forEach(b => mapB2.set(trim(b.cod), { qatu: toN(b.qatu), cm1: toN(b.cm1) }));
      }
      // PA: nao fica no armazem de MP — pega custo medio (MAX) e saldo total
      const paB2 = await Protheus.connectAndQuery(
        `SELECT ISNULL(MAX(B2_CM1), 0) cm1, ISNULL(SUM(B2_QATU), 0) qatu
           FROM SB2010 WITH (NOLOCK)
          WHERE D_E_L_E_T_ <> '*' AND B2_FILIAL = '01' AND RTRIM(B2_COD) = @produto`, { produto });
      const paCusto = paB2.length ? toN(paB2[0].cm1) : 0;
      const paSaldo = paB2.length ? toN(paB2[0].qatu) : 0;

      // 4) Monta workbook
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Intranet GNATUS';
      wb.created = new Date();

      // ===== Aba 1: Estrutura (layout da planilha de referencia, 27 colunas) =====
      // Lista PLANA dos componentes diretos do PA (PIs aparecem como 1 linha, sem
      // explodir). Saldo/C.Unitario do componente vem do armazem 21 (mapB2).
      // Impostos por unidade: IPI/ICMS = rateio da ultima compra (valor/qtd da NF);
      // PIS/COFINS = Valor Un x aliquota fixa. Totais = valor unitario x Quantidade.
      const PIS_RATE = 0.0165;     // 1,65%
      const COFINS_RATE = 0.076;   // 7,6%
      const wsEst = wb.addWorksheet('Estrutura');
      wsEst.columns = [
        { header: 'Produto Pai',               key: 'pai',        width: 12 },
        { header: 'Descricao',                  key: 'descPai',    width: 34 },
        { header: 'Saldo Atual',                key: 'saldoPai',   width: 12, style: { numFmt: '#,##0.00' } },
        { header: 'C Unitario',                 key: 'cUnitPai',   width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'Codigo',                     key: 'codigo',     width: 12 },
        { header: 'Descricao',                  key: 'descricao',  width: 46 },
        { header: 'Tipo',                       key: 'tipo',       width: 6 },
        { header: 'Grupo',                      key: 'grupo',      width: 8 },
        { header: 'Unidade',                    key: 'um',         width: 8 },
        { header: 'Saldo Atual',                key: 'saldo',      width: 12, style: { numFmt: '#,##0.00' } },
        { header: 'C Unitario',                 key: 'cUnit',      width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'Quantidade',                 key: 'qtd',        width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'Custo Total',                key: 'custoTotal', width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'Armazem',                    key: 'armazem',    width: 9 },
        { header: 'Valor Un.',                  key: 'valorUn',    width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'Valor IPI Un.',              key: 'ipiUn',      width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'Valor Un. + Valor IPI Un.',  key: 'unMaisIpi',  width: 16, style: { numFmt: '#,##0.0000' } },
        { header: 'Valor ICMS',                 key: 'icmsUn',     width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'Valor PIS',                  key: 'pisUn',      width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'Valor COFINS',               key: 'cofinsUn',   width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'Valor Bruto',                key: 'bruto',      width: 12, style: { numFmt: '#,##0.0000' } },
        { header: '',                           key: 'sep',        width: 3 },
        { header: 'Valor Bruto Total',          key: 'brutoTotal', width: 14, style: { numFmt: '#,##0.0000' } },
        { header: 'IPI Total',                  key: 'ipiTotal',   width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'ICMS Total',                 key: 'icmsTotal',  width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'PIS Total',                  key: 'pisTotal',   width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'COFINS Total',               key: 'cofinsTotal',width: 13, style: { numFmt: '#,##0.0000' } }
      ];

      // Explode RECURSIVAMENTE: lista todos os itens contidos no PA, em todos os
      // niveis (PIs/semiacabados sao abertos nos seus componentes). "Produto Pai"
      // de cada linha = o pai IMEDIATO; a descricao recebe recuo por nivel pra
      // mostrar a hierarquia. Quantidade = G1_QUANT relativo ao pai imediato.
      const escreverComp = (codPai, paiInfo, nivel) => {
        const itens = porPai.get(codPai) || [];
        for (const it of itens) {
          const b2 = mapB2.get(it.componente) || { qatu: 0, cm1: 0 };
          const u = mapUlt.get(it.componente);
          const qtdNF   = u ? toN(u.qtdComprada) : 0;
          const valorUn = u ? toN(u.vunit) : 0;
          const ipiUn   = u && qtdNF > 0 ? toN(u.ipi)  / qtdNF : 0;
          const icmsUn  = u && qtdNF > 0 ? toN(u.icms) / qtdNF : 0;
          const pisUn    = valorUn * PIS_RATE;
          const cofinsUn = valorUn * COFINS_RATE;
          const bruto    = valorUn + ipiUn;
          const qtd = it.qtd;  // Quantidade do BOM (G1_QUANT) relativo ao pai imediato
          const recuo = nivel > 0 ? '    '.repeat(nivel) : '';
          wsEst.addRow({
            pai: paiInfo.cod, descPai: paiInfo.desc, saldoPai: paiInfo.saldo, cUnitPai: paiInfo.cm1,
            codigo: it.componente, descricao: recuo + it.descricao, tipo: it.tipo, grupo: it.grupo, um: it.um,
            saldo: b2.qatu, cUnit: b2.cm1, qtd, custoTotal: b2.cm1 * qtd, armazem: armazemCusto,
            valorUn, ipiUn, unMaisIpi: valorUn + ipiUn, icmsUn, pisUn, cofinsUn, bruto,
            sep: '',
            brutoTotal: bruto * qtd, ipiTotal: ipiUn * qtd, icmsTotal: icmsUn * qtd,
            pisTotal: pisUn * qtd, cofinsTotal: cofinsUn * qtd
          });
          // Semiacabado (PI) com estrutura propria -> explode os filhos logo abaixo
          if (it.tipo === 'PI' && porPai.has(it.componente) && nivel < MAX_NIVEL) {
            escreverComp(it.componente,
              { cod: it.componente, desc: it.descricao, saldo: b2.qatu, cm1: b2.cm1 },
              nivel + 1);
          }
        }
      };
      escreverComp(produto, { cod: pa.cod, desc: pa.descricao, saldo: paSaldo, cm1: paCusto }, 0);

      // Cabecalho com formatacao
      wsEst.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      wsEst.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E5FB5' } };
      wsEst.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      wsEst.getRow(1).height = 30;
      wsEst.views = [{ state: 'frozen', ySplit: 1 }];

      // ===== Aba 2: Custo TOTVS =====
      const ws = wb.addWorksheet('Custo TOTVS');
      ws.columns = [
        { header: 'Codigo PA',                 key: 'codPA',     width: 12 },
        { header: 'Descricao PA',              key: 'descPA',    width: 38 },
        { header: 'Codigo',                    key: 'codigo',    width: 12 },
        { header: 'TP',                        key: 'tp',        width: 6 },
        { header: 'Descricao',                 key: 'descricao', width: 50 },
        { header: 'Qtde Necessaria',           key: 'qtdNec',    width: 14, style: { numFmt: '#,##0.0000' } },
        { header: 'UM',                        key: 'um',        width: 6 },
        { header: 'Ult. Compra',               key: 'ultCompra', width: 12 },
        { header: 'Fornecedor',                key: 'fornec',    width: 18 },
        { header: 'Nota Fiscal',               key: 'nf',        width: 16 },
        { header: 'Pedido',                    key: 'pedido',    width: 12 },
        { header: 'Qtde Item NF',              key: 'qtdNF',     width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'Valor Unit Item',           key: 'vunit',     width: 14, style: { numFmt: '#,##0.0000' } },
        { header: 'Valor Total Item NF',       key: 'totalNF',   width: 16, style: { numFmt: '#,##0.00' } },
        { header: 'Valor IPI Total Item',      key: 'ipi',       width: 14, style: { numFmt: '#,##0.00' } },
        { header: 'Valor ICMS Total Item',     key: 'icms',      width: 14, style: { numFmt: '#,##0.00' } },
        { header: 'Valor COFINS Total Item',   key: 'cofins',    width: 16, style: { numFmt: '#,##0.00' } },
        { header: 'Valor PIS Total Item',      key: 'pis',       width: 14, style: { numFmt: '#,##0.00' } },
        { header: 'Valor Frete Total Item',    key: 'frete',     width: 14, style: { numFmt: '#,##0.00' } },
        { header: 'Custo Bruto Unit',          key: 'brutoUnit', width: 14, style: { numFmt: '#,##0.0000' } },
        { header: 'Custo Liq Unit c/ IPI',     key: 'liqIPI',    width: 16, style: { numFmt: '#,##0.0000' } },
        { header: 'Custo Liq Unit',            key: 'liqUnit',   width: 14, style: { numFmt: '#,##0.0000' } }
      ];

      let custoTotalLiq = 0;
      for (const c of componentesRaiz) {
        const u = mapUlt.get(c.componente);
        const qtdNec = c.qtd * (1 + c.perda);
        const linha = {
          codPA: pa.cod, descPA: pa.descricao,
          codigo: c.componente, tp: c.tipo, descricao: c.descricao,
          qtdNec, um: c.um
        };
        if (u) {
          const qtdNF = toN(u.qtdComprada);
          const total = toN(u.total);
          const ipi = toN(u.ipi);
          const icms = toN(u.icms);
          const pis = toN(u.pis);
          const cofins = toN(u.cofins);
          const frete = toN(u.frete);
          const brutoUnit = safeDiv(total + ipi + icms + frete, qtdNF);
          const liqIPI    = safeDiv(total + ipi - icms - pis - cofins, qtdNF);
          const liqUnit   = safeDiv(total - icms - pis - cofins, qtdNF);
          Object.assign(linha, {
            ultCompra: fmtData(u.emissao),
            fornec: trim(u.fornece) ? `${trim(u.fornece)}/${trim(u.loja)}` : '',
            nf: trim(u.doc) ? `${trim(u.doc)}-${trim(u.serie)}` : '',
            pedido: trim(u.pedido),
            qtdNF, vunit: toN(u.vunit), totalNF: total,
            ipi, icms, cofins, pis, frete,
            brutoUnit, liqIPI, liqUnit
          });
          custoTotalLiq += liqUnit * qtdNec;
        }
        ws.addRow(linha);
      }

      // Linha de totais
      const linhaTotais = ws.addRow({});
      const ultCol = ws.columnCount;
      ws.mergeCells(linhaTotais.number, 1, linhaTotais.number, ultCol - 1);
      const cellTot = ws.getCell(linhaTotais.number, 1);
      cellTot.value = `Custo total liquido do PA (Σ Qtde × Custo Liq Unit) = R$ ${custoTotalLiq.toFixed(4)}`;
      cellTot.font = { bold: true };
      cellTot.alignment = { horizontal: 'right' };
      cellTot.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF1F6' } };

      // Header
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E5FB5' } };
      ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      ws.getRow(1).height = 32;
      ws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];   // congela cabecalho

      // Filtro automatico
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ultCol } };

      // 5) Gera buffer e responde
      const buffer = await wb.xlsx.writeBuffer();
      const nomeArq = `custo_${pa.cod}_${pa.descricao.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArq}"`);
      res.setHeader('Content-Length', buffer.length);
      return res.end(buffer);
    } catch (err) {
      console.error('custo-produto-xlsx:', err);
      return res.status(500).json({ message: 'Erro ao gerar planilha: ' + err.message });
    }
  }
});

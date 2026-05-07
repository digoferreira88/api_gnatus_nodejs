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
            tipo: trim(r.tipo), um: trim(r.um),
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

      // 4) Monta workbook
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Intranet GNATUS';
      wb.created = new Date();

      // ===== Aba 1: Estrutura =====
      const wsEst = wb.addWorksheet('Estrutura');
      wsEst.columns = [
        { header: 'Nivel', key: 'nivel', width: 8 },
        { header: 'Codigo PA', key: 'codPA', width: 12 },
        { header: 'Descricao PA', key: 'descPA', width: 38 },
        { header: 'Codigo', key: 'codigo', width: 12 },
        { header: 'TP', key: 'tipo', width: 6 },
        { header: 'Descricao', key: 'descricao', width: 50 },
        { header: 'Qtde', key: 'qtd', width: 12, style: { numFmt: '#,##0.0000' } },
        { header: 'Perda %', key: 'perda', width: 10, style: { numFmt: '0.00%' } },
        { header: 'Qtde c/ Perda', key: 'qtdPerda', width: 14, style: { numFmt: '#,##0.0000' } },
        { header: 'UM', key: 'um', width: 6 }
      ];

      const escreverEstrutura = (codPai, profundidade) => {
        const itens = porPai.get(codPai) || [];
        for (const it of itens) {
          const qtdPerda = it.qtd * (1 + it.perda);
          const recuo = '  '.repeat(profundidade);
          wsEst.addRow({
            nivel: profundidade + 1,
            codPA: profundidade === 0 ? pa.cod : '',
            descPA: profundidade === 0 ? pa.descricao : '',
            codigo: recuo + it.componente,
            tipo: it.tipo,
            descricao: it.descricao,
            qtd: it.qtd,
            perda: it.perda,
            qtdPerda,
            um: it.um
          });
          if (it.tipo === 'PI' && porPai.has(it.componente)) {
            escreverEstrutura(it.componente, profundidade + 1);
          }
        }
      };
      escreverEstrutura(produto, 0);

      // Cabecalho com formatacao
      wsEst.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      wsEst.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E5FB5' } };
      wsEst.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
      wsEst.getRow(1).height = 22;

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

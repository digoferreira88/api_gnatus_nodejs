// Saídas Diversas — RELATÓRIO COMPLETO (.xlsx), 1 linha por item de pedido.
//
// A tela mostra o resumo por TES; este é o detalhe que o relatório antigo entregava
// (relatorio-outras-saidas do intranet velho), com a mesma consulta e as mesmas
// colunas, mais Categoria e Item do pedido.
//
// GET /vendas/saidas-diversas-detalhe?inicio=AAAA-MM-DD&fim=AAAA-MM-DD
//     &vendedor=000123&categoria=diversos|acompanhar   -> baixa o .xlsx
//
// Duas colunas de estoque, como no relatório antigo:
//   Estoque     saldo disponível do item hoje (view itens_saldototal)
//   Disponível  o que sobra do estoque conforme as saídas da lista vão sendo
//               atendidas, na ordem do relatório. Item já faturado (estatus 99)
//               não consome — o estoque dele já saiu.

const ExcelJS = require('exceljs');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([2003, 2002]);

const trim = (v) => String(v == null ? '' : v).trim();
const up = (v) => trim(v).toUpperCase();
const N = (v) => Number(v || 0);
const toProtData = (iso) => { const s = String(iso || '').replace(/-/g, '').slice(0, 8); return /^\d{8}$/.test(s) ? s : null; };
const dataDe = (s) => { const v = trim(s); return v.length === 8 ? new Date(Number(v.slice(0, 4)), Number(v.slice(4, 6)) - 1, Number(v.slice(6, 8))) : null; };

const AZUL_ESCURO = 'FF1A3F82', AZUL = 'FF1E5FB5', AZUL_CLARO = 'FFEEF4FF', ZEBRA = 'FFF4F8FF', VERMELHO = 'FFC0392B';
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const M = '#,##0.00';

module.exports = (app) => ({
  verb: 'get',
  route: '/saidas-diversas-detalhe',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const inicio = toProtData(req.query.inicio);
    const fim = toProtData(req.query.fim);
    const vendedor = trim(req.query.vendedor);
    const categoria = trim(req.query.categoria).toLowerCase();

    if (!inicio || !fim) return res.status(400).json({ message: 'Informe o período (inicio e fim, no formato AAAA-MM-DD).' });

    try {
      const cats = await Pg.connectAndQuery(
        `SELECT tes, descricao, categoria FROM tab_vendas_tes_categoria WHERE ativo = true
          ${categoria === 'diversos' || categoria === 'acompanhar' ? 'AND categoria = @cat' : ''}
          ORDER BY categoria, tes`,
        categoria === 'diversos' || categoria === 'acompanhar' ? { cat: categoria } : {});
      if (!cats.length) {
        return res.status(400).json({ message: 'Nenhuma TES configurada para saídas diversas.' });
      }
      const infoTes = new Map(cats.map(c => [trim(c.tes), { descricao: trim(c.descricao), categoria: trim(c.categoria) }]));

      const params = { inicio, fim };
      cats.forEach((c, i) => { params[`t${i}`] = trim(c.tes); });
      const listaTes = cats.map((_, i) => `@t${i}`).join(',');
      let condVend = '';
      if (vendedor) { condVend = `AND (sc5.C5_VEND1 = @vend OR sc5.C5_VEND2 = @vend OR sc5.C5_VEND3 = @vend)`; params.vend = vendedor; }

      // Uma linha por item. As notas do item vêm agrupadas (item faturado em partes
      // tem mais de uma), para não multiplicar a linha e dobrar quantidade e valor —
      // era o efeito colateral do join direto no relatório antigo.
      const rows = await Protheus.connectAndQuery(`
        SELECT RTRIM(sc5.C5_ZTIPO) buCod,
               COALESCE(NULLIF(RTRIM(bu.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO)) bu,
               RTRIM(sc6.C6_TES) tes,
               sc6.C6_ENTREG entrega, sc5.C5_EMISSAO emissao, PE.c9_datalib liberacao,
               RTRIM(sc5.C5_VEND1) vendCod, RTRIM(sa3.A3_NOME) vendNome,
               RTRIM(sc6.C6_CLI) cliCod, RTRIM(sa1.A1_PESSOA) pessoa, RTRIM(sa1.A1_NOME) cliNome,
               CAST(sa1.A1_CGC AS VARCHAR(14)) cgc,
               RTRIM(PE.estatus) estatus, ISNULL(PE.estatus_cod, 0) estatusCod,
               RTRIM(sc6.C6_NUM) pedido, RTRIM(sc6.C6_ITEM) item,
               RTRIM(sc5.C5_ZFATPAR) fatParcial,
               RTRIM(sc6.C6_PRODUTO) produto, RTRIM(sc6.C6_DESCRI) descricao,
               sc6.C6_QTDVEN qtd, sc6.C6_VALOR valor,
               ISNULL(ST.disponivel, 0) estoque,
               nf.notas
          FROM SC6010 sc6 WITH (NOLOCK)
          LEFT JOIN SC5010 sc5 WITH (NOLOCK) ON sc6.C6_FILIAL = sc5.C5_FILIAL AND sc6.C6_NUM = sc5.C5_NUM
                AND sc5.D_E_L_E_T_ <> '*'
          LEFT JOIN SA3010 sa3 WITH (NOLOCK) ON sc5.C5_VEND1 = sa3.A3_COD AND sa3.D_E_L_E_T_ <> '*'
          LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_FILIAL = sc6.C6_FILIAL AND sc5.C5_CLIENTE = sa1.A1_COD
                AND sc5.C5_LOJACLI = sa1.A1_LOJA AND sa1.D_E_L_E_T_ <> '*'
          LEFT JOIN pedidos_estatus PE WITH (NOLOCK)
                 ON sc6.C6_FILIAL = PE.c6_filial AND sc6.C6_NUM = PE.c6_num
                AND sc6.C6_ITEM = PE.c6_item AND sc6.C6_PRODUTO = PE.c6_produto
          LEFT JOIN itens_saldototal ST WITH (NOLOCK) ON sc6.C6_PRODUTO = ST.B2_COD
          JOIN SB1010 sb1 WITH (NOLOCK) ON sb1.B1_FILIAL = '' AND sb1.B1_COD = sc6.C6_PRODUTO AND sb1.D_E_L_E_T_ <> '*'
          LEFT JOIN SX5010 bu WITH (NOLOCK) ON bu.X5_FILIAL = '  ' AND bu.X5_TABELA = 'Z1'
                AND RTRIM(bu.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND bu.D_E_L_E_T_ <> '*'
          OUTER APPLY (
            SELECT STRING_AGG(x.doc, ', ') notas
              FROM (SELECT DISTINCT RTRIM(sd2.D2_DOC) doc
                      FROM SD2010 sd2 WITH (NOLOCK)
                     WHERE sd2.D2_FILIAL = sc6.C6_FILIAL AND sd2.D2_PEDIDO = sc6.C6_NUM
                       AND sd2.D2_ITEMPV = sc6.C6_ITEM AND sd2.D_E_L_E_T_ <> '*') x
          ) nf
         WHERE sc6.C6_FILIAL = '01' AND sc6.D_E_L_E_T_ <> '*'
           AND sc5.C5_EMISSAO BETWEEN @inicio AND @fim
           AND RTRIM(sc6.C6_TES) IN (${listaTes})
           AND sc6.C6_BLQ = ' '
           ${condVend}
         ORDER BY sc6.C6_TES, sc6.C6_NUM, sc6.C6_PRODUTO`, params);

      const cols = [
        { h: 'BU', w: 22, f: 't' }, { h: 'TES', w: 6, f: 't', c: 1 }, { h: 'Categoria', w: 14, f: 't', c: 1 },
        { h: 'Descrição TES', w: 30, f: 't' }, { h: 'Entrega', w: 11, f: 'd' }, { h: 'Emissão', w: 11, f: 'd' },
        { h: 'Liberação', w: 11, f: 'd' }, { h: 'Cod.Vendedor', w: 11, f: 't', c: 1 }, { h: 'Vendedor', w: 26, f: 't' },
        { h: 'Cod.Cliente', w: 11, f: 't', c: 1 }, { h: 'Tipo', w: 6, f: 't', c: 1 }, { h: 'Nome', w: 40, f: 't' },
        { h: 'CPF/CNPJ', w: 16, f: 't' }, { h: 'Status', w: 34, f: 't' }, { h: 'Pedido', w: 10, f: 't', c: 1 },
        { h: 'Item', w: 6, f: 't', c: 1 }, { h: 'NF', w: 14, f: 't' }, { h: 'Fat.Parcial', w: 10, f: 't', c: 1 },
        { h: 'Produto', w: 14, f: 't' }, { h: 'Descrição', w: 42, f: 't' }, { h: 'Qtd', w: 11, f: 'q' },
        { h: 'Valor', w: 13, f: 'm' }, { h: 'Disponível', w: 12, f: 'q' }, { h: 'Estoque', w: 12, f: 'q' }
      ];
      const nCols = cols.length;
      const IDX = { disponivel: 23 };

      const wb = new ExcelJS.Workbook();
      wb.creator = 'Intranet Gnatus';
      const ws = wb.addWorksheet('Saídas Diversas', {
        views: [{ state: 'frozen', ySplit: 3 }],
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
      });

      ws.mergeCells(1, 1, 1, nCols);
      const t1 = ws.getCell(1, 1);
      t1.value = 'GNATUS  ·  SAÍDAS DIVERSAS';
      t1.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
      t1.fill = fill(AZUL_ESCURO);
      ws.getRow(1).height = 30;

      ws.mergeCells(2, 1, 2, nCols);
      const dd = (s) => `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
      const t2 = ws.getCell(2, 1);
      t2.value = `Emissão de ${dd(inicio)} a ${dd(fim)}  ·  ${rows.length.toLocaleString('pt-BR')} item(ns)`
        + `  ·  ${categoria ? 'categoria ' + categoria : 'acompanhamento e diversos'}`
        + (vendedor ? `  ·  vendedor ${vendedor}` : '  ·  todos os vendedores')
        + '  ·  Disponível = estoque menos as saídas desta lista, na ordem em que aparecem';
      t2.font = { name: 'Calibri', size: 10, italic: true, color: { argb: AZUL_ESCURO } };
      t2.fill = fill(AZUL_CLARO);
      ws.getRow(2).height = 20;

      const hr = ws.getRow(3);
      cols.forEach((c, i) => {
        const cell = hr.getCell(i + 1);
        cell.value = c.h;
        cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = fill(AZUL);
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
      });
      hr.height = 30;

      // Saldo que vai sobrando por produto, na ordem do relatório (regra do antigo).
      const saldo = new Map();
      let pedidoAtual = '', zebra = false, totalQtd = 0, totalValor = 0;

      rows.forEach(r => {
        const produto = trim(r.produto);
        const qtd = N(r.qtd);
        const faturado = N(r.estatusCod) === 99;
        if (!saldo.has(produto)) saldo.set(produto, N(r.estoque));
        if (!faturado) saldo.set(produto, saldo.get(produto) - qtd);
        const disponivel = saldo.get(produto);

        if (pedidoAtual !== trim(r.pedido)) { pedidoAtual = trim(r.pedido); zebra = !zebra; }
        const tes = trim(r.tes);
        const info = infoTes.get(tes) || { descricao: '', categoria: '' };
        totalQtd += qtd; totalValor += N(r.valor);

        const row = ws.addRow([
          up(r.bu), tes, info.categoria === 'acompanhar' ? 'Acompanhamento' : 'Diversos', info.descricao,
          dataDe(r.entrega), dataDe(r.emissao), dataDe(r.liberacao),
          trim(r.vendCod), up(r.vendNome), trim(r.cliCod), up(r.pessoa), up(r.cliNome), trim(r.cgc),
          up(r.estatus), trim(r.pedido), trim(r.item), trim(r.notas), up(r.fatParcial),
          produto, up(r.descricao), qtd, N(r.valor), disponivel, N(r.estoque)
        ]);
        row.height = 15;
        row.font = { name: 'Calibri', size: 9 };
        if (zebra) row.eachCell({ includeEmpty: true }, (cell) => { cell.fill = fill(ZEBRA); });
        // Saldo negativo = a soma das saídas passa do que existe em estoque.
        if (disponivel < 0) row.getCell(IDX.disponivel).font = { name: 'Calibri', size: 9, bold: true, color: { argb: VERMELHO } };
      });

      if (rows.length) {
        const tot = ws.addRow([]);
        tot.getCell(1).value = 'TOTAL';
        tot.getCell(21).value = totalQtd;
        tot.getCell(22).value = totalValor;
        tot.font = { name: 'Calibri', size: 10, bold: true };
        tot.eachCell({ includeEmpty: true }, (cell) => { cell.fill = fill(AZUL_CLARO); });
      }

      cols.forEach((c, i) => {
        const col = ws.getColumn(i + 1);
        col.width = c.w;
        if (c.f === 'm' || c.f === 'q') { col.numFmt = M; col.alignment = { horizontal: 'right' }; }
        else if (c.f === 'd') { col.numFmt = 'dd/mm/yyyy'; col.alignment = { horizontal: 'center' }; }
        else col.alignment = { horizontal: c.c ? 'center' : 'left' };
      });
      // CPF/CNPJ é texto: zero à esquerda não pode sumir.
      ws.getColumn(13).numFmt = '@';
      hr.eachCell((cell) => { cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
      ws.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      ws.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: nCols } };

      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="saidas-diversas-${inicio}-${fim}-${stamp}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error('Erro vendas/saidas-diversas-detalhe:', err);
      if (!res.headersSent) return res.status(500).json({ message: 'Erro ao gerar o relatório: ' + err.message });
      res.end();
    }
  }
});

// GET /planejamento/estoque-export
// Relatório de Saldo em Estoque e Custo (.xlsx) — réplica do export da intranet
// antiga, MESMA ordem de colunas (o time do estoque já as mapeia), com formatação
// profissional via ExcelJS. Permissão 3001 (Disponibilidade) ou 11001 (Estoque).
//
// Otimização: as 3 subqueries correlacionadas de "Última Compra" (UC) viraram uma
// CTE com ROW_NUMBER (1 passada na SD1) em vez de 3 subqueries por linha.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([3001, 11001]);
const ExcelJS = require('exceljs');

const trim = (v) => String(v == null ? '' : v).trim();
const num = (v) => (v == null || v === '' ? null : Number(v));
const ymdToDate = (s) => { s = trim(s); if (!/^\d{8}$/.test(s)) return null; const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)); return isNaN(d) ? null : d; };

// Cores (mesma identidade dos outros relatórios)
const AZUL_ESCURO = 'FF1A3F82', AZUL = 'FF1E5FB5', ZEBRA = 'FFF4F7FC', VERMELHO = 'FFC0392B', BORDA = 'FFD9E1EC';

// Colunas NA ORDEM EXATA do relatório antigo
const COLS = [
  { key: 'codigo', header: 'Código', width: 14 },
  { key: 'descricao', header: 'Descrição', width: 48 },
  { key: 'bloq', header: 'Bloq', width: 11, align: 'center' },
  { key: 'tipo', header: 'Tipo', width: 8, align: 'center' },
  { key: 'endereco', header: 'Endereço', width: 16 },
  { key: 'armazem', header: 'Armazém', width: 11, align: 'center' },
  { key: 'saldo', header: 'Saldo', width: 12, numFmt: '#,##0.000', align: 'right' },
  { key: 'disponivel', header: 'Disponível', width: 12, numFmt: '#,##0.00', align: 'right' },
  { key: 'custoMedio', header: 'Custo Médio', width: 14, numFmt: 'R$ #,##0.00', align: 'right' },
  { key: 'valorEstoque', header: 'Valor Estoque', width: 16, numFmt: 'R$ #,##0.00', align: 'right' },
  { key: 'ucNfe', header: 'UC NFE', width: 13, align: 'center' },
  { key: 'ucQtd', header: 'UC Qtd', width: 12, numFmt: '#,##0.000', align: 'right' },
  { key: 'ucEmissao', header: 'UC Emissão', width: 13, numFmt: 'dd/mm/yyyy', align: 'center' }
];

module.exports = (app) => ({
  verb: 'get',
  route: '/estoque-export',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    try {
      const rows = await Protheus.connectAndQuery(`
        WITH uc AS (
          SELECT d1_cod cod, d1_local loc, RTRIM(d1_doc) doc, d1_quant qtd, d1_emissao emissao,
                 ROW_NUMBER() OVER (PARTITION BY d1_cod, d1_local ORDER BY d1_emissao DESC, R_E_C_N_O_ DESC) rn
            FROM SD1010 WITH (NOLOCK)
           WHERE d1_filial = '01' AND d1_cf IN ('1101','1102','2101','2102') AND D_E_L_E_T_ <> '*'
        )
        SELECT
          RTRIM(b1.b1_cod)  codigo,
          RTRIM(b1.b1_desc) descricao,
          CASE WHEN RTRIM(b1.b1_msblql) = '1' THEN 'Bloqueado' ELSE '' END bloq,
          RTRIM(b1.b1_tipo) tipo,
          RTRIM(b1.b1_zzend) endereco,
          RTRIM(b2.b2_local) armazem,
          b2.b2_qatu saldo,
          (b2.b2_qatu - b2.b2_reserva - b2.b2_qemp - b2.b2_qaclass - b2.b2_qempsa - b2.b2_qtnp - b2.b2_qemppre) disponivel,
          b2.b2_cm1 custoMedio,
          (b2.b2_cm1 * b2.b2_qatu) valorEstoque,
          uc.doc ucNfe, uc.qtd ucQtd, uc.emissao ucEmissao
        FROM SB1010 b1 WITH (NOLOCK)
        LEFT JOIN SB2010 b2 WITH (NOLOCK)
          ON b2.b2_cod = b1.b1_cod AND b2.b2_filial = '01' AND b2.D_E_L_E_T_ <> '*'
        LEFT JOIN uc ON uc.cod = b1.b1_cod AND uc.loc = b2.b2_local AND uc.rn = 1
        WHERE b1.D_E_L_E_T_ <> '*'
        ORDER BY b1.b1_cod, b2.b2_local`, {});

      const wb = new ExcelJS.Workbook();
      wb.creator = 'Intranet Gnatus';
      const ws = wb.addWorksheet('Estoque', {
        views: [{ state: 'frozen', ySplit: 3 }],
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
      });
      const nCols = COLS.length;
      const lastColLetter = ws.getColumn(nCols).letter;

      // Linha 1 — título
      ws.mergeCells(1, 1, 1, nCols);
      const t = ws.getCell(1, 1);
      t.value = 'GNATUS · RELATÓRIO DE SALDO EM ESTOQUE E CUSTO';
      t.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
      t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL_ESCURO } };
      t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      ws.getRow(1).height = 26;

      // Linha 2 — subtítulo
      ws.mergeCells(2, 1, 2, nCols);
      const sub = ws.getCell(2, 1);
      sub.value = `Gerado em ${new Date().toLocaleString('pt-BR')} · ${rows.length.toLocaleString('pt-BR')} linhas · Filial 01`;
      sub.font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF5A6B82' } };
      sub.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3FA' } };
      sub.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      ws.getRow(2).height = 16;

      // Linha 3 — cabeçalho
      const head = ws.getRow(3);
      COLS.forEach((c, i) => {
        const cell = head.getCell(i + 1);
        cell.value = c.header;
        cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AZUL } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = { bottom: { style: 'thin', color: { argb: BORDA } } };
      });
      head.height = 22;
      ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: nCols } };

      // Dados
      let r = 4;
      for (const row of rows) {
        const dados = {
          codigo: trim(row.codigo), descricao: trim(row.descricao), bloq: trim(row.bloq),
          tipo: trim(row.tipo), endereco: trim(row.endereco), armazem: trim(row.armazem),
          saldo: num(row.saldo), disponivel: num(row.disponivel), custoMedio: num(row.custoMedio),
          valorEstoque: num(row.valorEstoque), ucNfe: trim(row.ucNfe), ucQtd: num(row.ucQtd),
          ucEmissao: ymdToDate(row.ucEmissao)
        };
        const linha = ws.getRow(r);
        const bloqueado = dados.bloq !== '';
        const dispNeg = dados.disponivel != null && dados.disponivel < 0;
        COLS.forEach((c, i) => {
          const cell = linha.getCell(i + 1);
          cell.value = dados[c.key];
          cell.font = { name: 'Calibri', size: 9, color: { argb: bloqueado ? VERMELHO : 'FF1F2D3D' } };
          if (c.numFmt) cell.numFmt = c.numFmt;
          cell.alignment = { vertical: 'middle', horizontal: c.align || 'left' };
          if (r % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } };
          if (c.key === 'disponivel' && dispNeg) cell.font = { name: 'Calibri', size: 9, bold: true, color: { argb: VERMELHO } };
          if (c.key === 'bloq' && bloqueado) cell.font = { name: 'Calibri', size: 9, bold: true, color: { argb: VERMELHO } };
        });
        r++;
      }

      // Larguras
      COLS.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });

      const fname = `relatorio-estoque-custo-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error('Erro estoque-export:', err);
      if (!res.headersSent) return res.status(500).json({ message: 'Erro ao gerar relatório: ' + err.message });
      res.end();
    }
  }
});

// Carteira de Pedidos — EXPORT DETALHADO (.xlsx), 1 linha por item, toda a
// carteira (todos os estatus). Reproduz o relatorio da intranet antiga
// (mesma query/colunas/formulas) num XLSX PROFISSIONAL via ExcelJS:
// cabecalho estilizado, painel congelado, auto-filtro, formatos numericos,
// zebra e realces. Dados de texto em CAIXA ALTA.
//
// GET /vendas/carteira-detalhe?vendedor=000123   -> baixa o .xlsx
//
// As 3 colunas de custo acumulado (Saldo Faturado / Saldo Reposicao /
// % Margem Total) so saem para quem tem a permissao 2006 (ou admin perm 0).

const ExcelJS = require('exceljs');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([2004, 2002]);
const PERM_CUSTO = 2006;   // "Vendas - Custo e Margem da Carteira"

const trim = (v) => String(v == null ? '' : v).trim();
const up   = (v) => trim(v).toUpperCase();
const N    = (v) => Number(v || 0);

const CFOPS_CARTEIRA = ['5105','5106','5116','5117','5119','5405','5933','6105','6106','6107','6108','6110','6116','6117','6119','6122','6123','6404','6933','5924'];

const FORMAS_PGTO = {
  '1':'Cheque','2':'Dinheiro','3':'Cartão','4':'Boleto','5':'Não informado',
  '6':'Financiamento','7':'Cartão BNDS','8':'Bonificação','9':'Consignado',
  'A':'Futuro Garantido','B':'Antecipação Parcelada'
};
const formaPgto = (cod) => { const c = trim(cod); return c ? `${c} - ${FORMAS_PGTO[c] || 'Forma ' + c}` : ''; };

const REGIAO = {
  AC:'Norte',AM:'Norte',AP:'Norte',PA:'Norte',RO:'Norte',RR:'Norte',TO:'Norte',
  AL:'Nordeste',BA:'Nordeste',CE:'Nordeste',MA:'Nordeste',PB:'Nordeste',PE:'Nordeste',PI:'Nordeste',RN:'Nordeste',SE:'Nordeste',
  DF:'Centro-Oeste',GO:'Centro-Oeste',MT:'Centro-Oeste',MS:'Centro-Oeste',
  ES:'Sudeste',MG:'Sudeste',RJ:'Sudeste',SP:'Sudeste',
  PR:'Sul',RS:'Sul',SC:'Sul'
};
const regiao = (uf) => REGIAO[up(uf)] || '';
const ymdDate = (s) => { s = trim(s); return s.length === 8 ? new Date(Number(s.slice(0,4)), Number(s.slice(4,6)) - 1, Number(s.slice(6,8))) : null; };

// Paleta
const AZUL_ESCURO = 'FF1A3F82', AZUL = 'FF1E5FB5', AZUL_CLARO = 'FFEEF4FF';
const ZEBRA = 'FFF4F8FF', PARCIAL = 'FFFFF3E0', LARANJA = 'FFFF9900', VERMELHO = 'FFC0392B';
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

module.exports = (app) => ({
  verb: 'get',
  route: '/carteira-detalhe',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;
    const user = req.user && req.user[0];
    const vendedor = trim(req.query.vendedor);

    try {
      // Permissao pra ver custo/margem acumulados (admin perm 0 sempre passa)
      let podeCusto = false;
      try {
        const pc = await Pg.connectAndQuery(
          `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @id AND id_permissao IN (0, @perm) LIMIT 1`,
          { id: user.ID, perm: PERM_CUSTO });
        podeCusto = pc.length > 0;
      } catch (e) { console.warn('carteira-detalhe perm custo:', e.message); }

      const vendRows = await Protheus.connectAndQuery(
        `SELECT RTRIM(A3_COD) cod, RTRIM(A3_NOME) nome FROM SA3010 WITH (NOLOCK) WHERE D_E_L_E_T_ <> '*'`, {});
      const vendMap = new Map();
      vendRows.forEach(v => vendMap.set(trim(v.cod), trim(v.nome)));
      const vendNome = (cod) => { const c = trim(cod); return c && vendMap.get(c) ? up(vendMap.get(c)) : 'DESCONHECIDO'; };

      const cfopList = CFOPS_CARTEIRA.map(c => `'${c}'`).join(',');
      const params = {};
      let condVend = '';
      if (vendedor) { condVend = `AND (sc5.C5_VEND1 = @vend OR sc5.C5_VEND2 = @vend OR sc5.C5_VEND3 = @vend)`; params.vend = vendedor; }

      const sql = `
        SELECT
          RTRIM(sc5.C5_ZTIPO) ztipo,
          COALESCE(NULLIF(RTRIM(bu.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO)) tipo_desc,
          sc5.C5_EMISSAO emissao, sc6.C6_ENTREG entreg,
          RTRIM(sc5.C5_ZFATPAR) zfatpar, RTRIM(sc5.C5_FORMAPG) formapg,
          RTRIM(sc5.C5_VEND1) vend1, RTRIM(sc5.C5_VEND2) vend2, RTRIM(sc5.C5_VEND3) vend3,
          ISNULL(TP6.total,0) total_pedido, ISNULL(TP62.total,0) valor_saldo,
          RTRIM(sc6.C6_FILIAL) filial, RTRIM(sc6.C6_LOCAL) armazem,
          DATEDIFF(DAY, sc5.C5_EMISSAO, sc6.C6_ENTREG) dias,
          RTRIM(sc6.C6_NUM) num, RTRIM(sc6.C6_NOTA) nota, RTRIM(sc6.C6_CLI) cli,
          RTRIM(sa1.A1_PESSOA) pessoa, RTRIM(sa1.A1_NOME) nome, RTRIM(sa1.A1_CGC) cgc,
          RTRIM(sc6.C6_ITEM) item, RTRIM(sc6.C6_PRODUTO) produto, RTRIM(sc6.C6_DESCRI) descri, RTRIM(sc6.C6_UM) um,
          sc6.C6_QTDVEN qtdven, sc6.C6_QTDENT qtdent, (sc6.C6_QTDVEN - sc6.C6_QTDENT) saldo,
          CAST(sc6.C6_ZPRCVEN AS DECIMAL(14,2)) unitario,
          CAST(sc6.C6_QTDVEN * sc6.C6_ZPRCVEN AS DECIMAL(14,2)) total_item,
          CAST(sc6.C6_ZPRCVEN * (sc6.C6_QTDVEN - sc6.C6_QTDENT) AS DECIMAL(14,2)) total_parcial,
          RTRIM(sc6.C6_TES) tes, RTRIM(sc6.C6_CF) cfop, RTRIM(sa1.A1_EST) uf,
          CAST(ISNULL(PRA.saldo,0) AS NUMERIC(14,2)) pago,
          CAST(ISNULL(PRF.saldo,0) AS NUMERIC(14,2)) pagar,
          CAST(ISNULL(PRA.saldo,0)+ISNULL(PRF.saldo,0) AS NUMERIC(14,2)) totalfinan,
          CAST(ISNULL(sc5.C5_ZTOTAL,0)-ISNULL(PRA.saldo,0)-ISNULL(PRF.saldo,0) AS NUMERIC(14,2)) diffinan,
          RTRIM(PE.estatus) estatus, ISNULL(PE.estatus_cod,0) estatus_cod,
          RTRIM(sc5.C5_ZEXPRES) zexpres, RTRIM(sc5.C5_CONDPAG) condpag, RTRIM(cnd.E4_DESCRI) cond_desc,
          ISNULL(b2.B2_CM1,0) b2_cm1, RTRIM(sc5.C5_ZGERFIN) geratp,
          CAST(ISNULL(sc5.C5_VLMINFT,0) AS NUMERIC(14,2)) recminfat
        FROM SC6010 sc6 WITH (NOLOCK)
        LEFT JOIN SC5010 sc5 WITH (NOLOCK) ON sc6.C6_NUM = sc5.C5_NUM
        LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sc5.C5_CLIENTE = sa1.A1_COD AND sc5.C5_LOJACLI = sa1.A1_LOJA
        LEFT JOIN SB1010 sb1 WITH (NOLOCK) ON sb1.B1_FILIAL = '' AND sc6.C6_PRODUTO = sb1.B1_COD
        LEFT JOIN pedidos_ra PRA WITH (NOLOCK) ON sc6.C6_NUM = PRA.pedido
        LEFT JOIN pedidos_rf PRF WITH (NOLOCK) ON sc6.C6_NUM = PRF.pedido
        LEFT JOIN total_pedido_sc6 TP6 WITH (NOLOCK) ON sc6.C6_NUM = TP6.c6_num
        LEFT JOIN total_pedido_sc6_saldo TP62 WITH (NOLOCK) ON sc6.C6_NUM = TP62.c6_num
        LEFT JOIN pedidos_estatus PE WITH (NOLOCK)
          ON sc6.C6_FILIAL = PE.c6_filial AND sc6.C6_NUM = PE.c6_num AND sc6.C6_ITEM = PE.c6_item AND sc6.C6_PRODUTO = PE.c6_produto
        LEFT JOIN SE4010 cnd WITH (NOLOCK) ON sc5.C5_CONDPAG = cnd.E4_CODIGO
        LEFT JOIN SB2010 b2 WITH (NOLOCK)
          ON b2.B2_FILIAL = sc6.C6_FILIAL AND b2.B2_LOCAL = sc6.C6_LOCAL AND b2.B2_COD = sc6.C6_PRODUTO AND b2.D_E_L_E_T_ = ''
        LEFT JOIN SX5010 bu WITH (NOLOCK)
          ON bu.X5_FILIAL = '  ' AND bu.X5_TABELA = 'Z1' AND RTRIM(bu.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND bu.D_E_L_E_T_ <> '*'
        WHERE sc6.C6_FILIAL = '01' AND sc6.D_E_L_E_T_ <> '*' AND sc5.D_E_L_E_T_ <> '*'
          AND sb1.D_E_L_E_T_ <> '*' AND sa1.D_E_L_E_T_ <> '*' AND sc5.C5_FILIAL = '01'
          AND sc6.C6_CF IN (${cfopList})
          AND (sc6.C6_QTDVEN - sc6.C6_QTDENT) > 0 AND sc6.C6_BLQ = ' '
          ${condVend}
        ORDER BY sc5.C5_ZTIPO, sc6.C6_NUM, sc6.C6_ITEM`;

      const rows = await Protheus.connectAndQuery(sql, params);

      // Margem por pedido (= soma) e contagem de pedidos
      const pedAgg = new Map();
      rows.forEach(r => {
        const num = trim(r.num); const custo = N(r.b2_cm1) * N(r.saldo);
        const a = pedAgg.get(num) || { custo: 0, parcial: 0 };
        a.parcial += N(r.total_parcial); if (custo > 0) a.custo += custo;
        pedAgg.set(num, a);
      });
      const margemPedido = (num) => { const a = pedAgg.get(num); return a && a.parcial > 0 ? 100 - (a.custo / a.parcial) * 100 : 0; };

      // ===== Colunas (fmt: t=texto, m=dinheiro, q=qtd, p=%, i=int, d=data) =====
      const M = '#,##0.00', P = '0.00"%"';
      const cols = [
        { h:'Tipo', w:24, f:'t' }, { h:'Filial', w:6, f:'t', c:1 }, { h:'Emissão', w:11, f:'d' }, { h:'Data Entrega', w:12, f:'d' },
        { h:'Dias', w:6, f:'i' }, { h:'Gera TP', w:8, f:'t', c:1 }, { h:'Forma Pagto', w:16, f:'t' }, { h:'Cond. Pagto', w:18, f:'t' },
        { h:'Pedido', w:10, f:'t' }, { h:'Expresso', w:9, f:'t', c:1 }, { h:'Pode Fat.Parcial', w:10, f:'t', c:1 }, { h:'Estatus', w:34, f:'t' },
        { h:'NF', w:10, f:'t' }, { h:'Cod.Vend', w:9, f:'t' }, { h:'Vendedor', w:24, f:'t' }, { h:'Cod.Vend2', w:9, f:'t' },
        { h:'Vendedor2', w:18, f:'t' }, { h:'Cod.Vend3', w:9, f:'t' }, { h:'Vendedor3', w:18, f:'t' }, { h:'Cod.Cliente', w:11, f:'t' },
        { h:'TipoCli', w:7, f:'t', c:1 }, { h:'Nome', w:40, f:'t' }, { h:'CPF/CNPJ', w:16, f:'t' }, { h:'Seq', w:6, f:'t', c:1 },
        { h:'Codigo', w:10, f:'t' }, { h:'Descrição', w:42, f:'t' }, { h:'Unidade', w:8, f:'t', c:1 }, { h:'Quantidade', w:11, f:'q' },
        { h:'Entregue', w:11, f:'q' }, { h:'Saldo', w:11, f:'q' }, { h:'Unitário', w:12, f:'m' }, { h:'Total Item', w:13, f:'m' },
        { h:'Total Parcial', w:13, f:'m' }, { h:'Armazém', w:8, f:'t', c:1 }, { h:'Custo Médio', w:12, f:'m' }, { h:'% Margem Item', w:11, f:'p' },
        { h:'% Margem Pedido', w:12, f:'p' }, { h:'Total Pedido', w:13, f:'m' }, { h:'Saldo Pedido', w:13, f:'m' }, { h:'Financeiro', w:13, f:'m' },
        { h:'Verifica Fin.', w:22, f:'t' }, { h:'A Receber', w:12, f:'m' }, { h:'Recebido', w:12, f:'m' }, { h:'Diferença', w:13, f:'m' },
        { h:'Rec.Min.Fat', w:12, f:'m' }, { h:'Instrução', w:28, f:'t' }, { h:'TES', w:6, f:'t', c:1 }, { h:'CFOP', w:7, f:'t', c:1 },
        { h:'Destino', w:8, f:'t', c:1 }, { h:'Região', w:13, f:'t' }
      ];
      if (podeCusto) cols.push(
        { h:'Saldo Faturado', w:14, f:'m' }, { h:'Saldo Reposição', w:14, f:'m' }, { h:'% Margem Total', w:12, f:'p' }
      );
      const nCols = cols.length;

      // indices (1-based) usados em realces condicionais
      const IDX = { margemItem: 36, verifFin: 41, diferenca: 44, instrucao: 46 };

      const wb = new ExcelJS.Workbook();
      wb.creator = 'Intranet Gnatus';
      const ws = wb.addWorksheet('Carteira de Pedidos', {
        views: [{ state: 'frozen', ySplit: 3, xSplit: 0 }],
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
      });

      // Linha 1 — titulo
      ws.mergeCells(1, 1, 1, nCols);
      const t1 = ws.getCell(1, 1);
      t1.value = 'GNATUS  ·  CARTEIRA DE PEDIDOS';
      t1.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
      t1.fill = fill(AZUL_ESCURO);
      t1.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      ws.getRow(1).height = 30;

      // Linha 2 — subtitulo (gerado em / contagens / filtro)
      ws.mergeCells(2, 1, 2, nCols);
      const nPedidos = pedAgg.size;
      const dt = new Date();
      const dd = `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
      const filtroTxt = vendedor ? `  ·  Vendedor: ${vendedor} - ${vendNome(vendedor)}` : '  ·  Todos os vendedores';
      const t2 = ws.getCell(2, 1);
      t2.value = `Gerado em ${dd}  ·  ${nPedidos.toLocaleString('pt-BR')} pedido(s)  ·  ${rows.length.toLocaleString('pt-BR')} item(ns)${filtroTxt}`;
      t2.font = { name: 'Calibri', size: 10, italic: true, color: { argb: AZUL_ESCURO } };
      t2.fill = fill(AZUL_CLARO);
      t2.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      ws.getRow(2).height = 20;

      // Linha 3 — cabecalho
      const hr = ws.getRow(3);
      cols.forEach((c, i) => {
        const cell = hr.getCell(i + 1);
        cell.value = c.h;
        cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = fill(AZUL);
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } }, right: { style: 'hair', color: { argb: 'FFBBCCDD' } } };
      });
      hr.height = 30;

      // ===== Dados =====
      let docNum = '', bgNum = '', zebra = false;
      let tot4 = 0, tot5 = 0, tot6 = 0;

      rows.forEach(r => {
        const num = trim(r.num);
        if (bgNum !== num) { bgNum = num; zebra = !zebra; }
        const custoTotal = N(r.b2_cm1) * N(r.saldo);
        const totalParcial = N(r.total_parcial);
        const margemItem = custoTotal > 0 && totalParcial > 0 ? 100 - (custoTotal / totalParcial) * 100 : 0;
        const primeira = docNum !== num;
        const totalPed = N(r.total_pedido), valorSaldo = N(r.valor_saldo);

        tot4 += totalParcial; if (custoTotal > 0) tot5 += custoTotal;
        if (tot5 !== 0 && tot4 !== 0) tot6 = 100 - (tot5 / tot4) * 100;

        const verif = (trim(r.geratp) === 'S' && N(r.diffinan) !== 0 && N(r.estatus_cod) > 1)
          ? `VERIFICAR FINANCEIRO ${N(r.diffinan).toLocaleString('pt-BR',{minimumFractionDigits:2})}` : '';
        const restricao = (N(r.recminfat) > 0 && N(r.recminfat) > N(r.pago)) ? 'NÃO LIBERAR - TEM RESTRIÇÃO DE PAGTO' : '';

        const vals = [
          up(r.tipo_desc), up(r.filial), ymdDate(r.emissao), ymdDate(r.entreg), N(r.dias),
          trim(r.geratp) === 'S' ? 'SIM' : 'NÃO', up(formaPgto(r.formapg)),
          up(`${trim(r.condpag)}${trim(r.cond_desc) ? ' - ' + trim(r.cond_desc) : ''}`),
          up(num), up(r.zexpres), up(r.zfatpar), up(r.estatus), up(r.nota),
          up(r.vend1), vendNome(r.vend1), up(r.vend2), vendNome(r.vend2), up(r.vend3), vendNome(r.vend3),
          up(r.cli), up(r.pessoa), up(r.nome), up(r.cgc), up(r.item), up(r.produto), up(r.descri), up(r.um),
          N(r.qtdven), N(r.qtdent), N(r.saldo), N(r.unitario), N(r.total_item), totalParcial, up(r.armazem),
          custoTotal, margemItem, margemPedido(num),
          primeira ? totalPed : null, primeira ? valorSaldo : null, primeira ? N(r.totalfinan) : null,
          primeira ? verif : null, primeira ? N(r.pagar) : null, primeira ? N(r.pago) : null,
          primeira ? (totalPed - N(r.pago)) : null, primeira ? N(r.recminfat) : null, primeira ? restricao : null,
          up(r.tes), up(r.cfop), up(r.uf), up(regiao(r.uf))
        ];
        if (podeCusto) vals.push(tot4, tot5, tot6);
        if (primeira) docNum = num;

        const row = ws.addRow(vals);
        row.height = 15;
        // estilo base + zebra
        const baseFill = N(r.qtdent) > 0 ? PARCIAL : (zebra ? ZEBRA : null);
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.font = { name: 'Calibri', size: 9 };
          if (baseFill) cell.fill = fill(baseFill);
        });
        // realces condicionais
        if (margemItem < 10) {
          const mc = row.getCell(IDX.margemItem);
          mc.fill = fill(LARANJA); mc.font = { name: 'Calibri', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
        }
        if (verif) row.getCell(IDX.verifFin).font = { name: 'Calibri', size: 9, bold: true, color: { argb: VERMELHO } };
        if (restricao) row.getCell(IDX.instrucao).font = { name: 'Calibri', size: 9, bold: true, color: { argb: VERMELHO } };
        if (primeira && (totalPed - N(r.pago)) < 0) row.getCell(IDX.diferenca).font = { name: 'Calibri', size: 9, color: { argb: VERMELHO } };
      });

      // larguras + formatos + alinhamento por coluna
      cols.forEach((c, i) => {
        const col = ws.getColumn(i + 1);
        col.width = c.w;
        if (c.f === 'm' || c.f === 'q') { col.numFmt = M; col.alignment = { horizontal: 'right' }; }
        else if (c.f === 'p') { col.numFmt = P; col.alignment = { horizontal: 'right' }; }
        else if (c.f === 'i') { col.numFmt = '0'; col.alignment = { horizontal: 'center' }; }
        else if (c.f === 'd') { col.numFmt = 'dd/mm/yyyy'; col.alignment = { horizontal: 'center' }; }
        else col.alignment = { horizontal: c.c ? 'center' : 'left' };
      });
      // re-aplica alinhamento/estilo do cabecalho (sobrepoe o da coluna)
      hr.eachCell((cell) => { cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
      // titulo e subtitulo SEMPRE a esquerda (apos os ajustes de coluna)
      ws.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' };
      ws.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'left' };

      ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: nCols } };

      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="carteiradepedidos-${stamp}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error('Erro vendas/carteira-detalhe:', err);
      if (!res.headersSent) return res.status(500).json({ message: 'Erro ao gerar o relatório: ' + err.message });
      res.end();
    }
  }
});

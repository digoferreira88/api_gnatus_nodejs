// Carteira de Pedidos — EXPORT DETALHADO (.xls), 1 linha por item, toda a
// carteira (todos os estatus). Replica fielmente o relatorio da intranet antiga
// (carteiradepedidos-*.xls): mesma query, mesmas 53 colunas, mesmas formulas e
// o mesmo formato .xls (tabela HTML + mso-number-format que o Excel abre nativo).
//
// GET /vendas/carteira-detalhe?vendedor=000123   -> baixa o .xls
//
// Colunas financeiras/pedido (Total Pedido, Saldo Pedido, A Receber, Recebido,
// Diferenca, Rec.Min.Fat, Verifica Fin., restricao) aparecem so na 1a linha de
// cada pedido. Saldo Faturado/Reposicao/% Margem Total sao acumulados corridos.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([2004, 2002]);

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

// CFOPs de venda da carteira — mesma lista fixa do relatorio legado (garante
// que o export bata 1:1 com o XLS antigo).
const CFOPS_CARTEIRA = ['5105','5106','5116','5117','5119','5405','5933','6105','6106','6107','6108','6110','6116','6117','6119','6122','6123','6404','6933','5924'];

const FORMAS_PGTO = {
  '1': 'Cheque', '2': 'Dinheiro', '3': 'Cartão', '4': 'Boleto', '5': 'Não informado',
  '6': 'Financiamento', '7': 'Cartão BNDS', '8': 'Bonificação', '9': 'Consignado',
  'A': 'Futuro Garantido', 'B': 'Antecipação Parcelada'
};
const formaPgto = (cod) => { const c = trim(cod); return c ? `${c} - ${FORMAS_PGTO[c] || 'Forma ' + c}` : ''; };

// UF -> regiao (igual get_regiao_venda do legado)
const REGIAO = {
  AC:'Norte', AM:'Norte', AP:'Norte', PA:'Norte', RO:'Norte', RR:'Norte', TO:'Norte',
  AL:'Nordeste', BA:'Nordeste', CE:'Nordeste', MA:'Nordeste', PB:'Nordeste', PE:'Nordeste', PI:'Nordeste', RN:'Nordeste', SE:'Nordeste',
  DF:'Centro-Oeste', GO:'Centro-Oeste', MT:'Centro-Oeste', MS:'Centro-Oeste',
  ES:'Sudeste', MG:'Sudeste', RJ:'Sudeste', SP:'Sudeste',
  PR:'Sul', RS:'Sul', SC:'Sul'
};
const regiao = (uf) => REGIAO[trim(uf).toUpperCase()] || '';

const fmtData = (s) => { s = trim(s); return s.length === 8 ? `${s.slice(6,8)}/${s.slice(4,6)}/${s.slice(0,4)}` : ''; };
const numBR = (n) => N(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (v) => String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const td  = (v, cls, style) => `<td${cls ? ` class='${cls}'` : ''}${style ? ` style="${style}"` : ''}>${esc(v)}</td>`;

module.exports = (app) => ({
  verb: 'get',
  route: '/carteira-detalhe',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const vendedor = trim(req.query.vendedor);

    try {
      // Vendedores (cod -> nome), igual o legado pre-carrega a SA3.
      const vendRows = await Protheus.connectAndQuery(
        `SELECT RTRIM(A3_COD) cod, RTRIM(A3_NOME) nome FROM SA3010 WITH (NOLOCK) WHERE D_E_L_E_T_ <> '*'`, {});
      const vendMap = new Map();
      vendRows.forEach(v => vendMap.set(trim(v.cod), trim(v.nome)));
      const vendNome = (cod) => { const c = trim(cod); return c && vendMap.get(c) ? vendMap.get(c) : 'DESCONHECIDO'; };

      const cfopList = CFOPS_CARTEIRA.map(c => `'${c}'`).join(',');
      const params = {};
      let condVend = '';
      if (vendedor) { condVend = `AND (sc5.C5_VEND1 = @vend OR sc5.C5_VEND2 = @vend OR sc5.C5_VEND3 = @vend)`; params.vend = vendedor; }

      const sql = `
        SELECT
          RTRIM(sc5.C5_ZTIPO) ztipo,
          COALESCE(NULLIF(RTRIM(bu.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO)) tipo_desc,
          sc5.C5_EMISSAO emissao,
          RTRIM(sc5.C5_ZFATPAR) zfatpar,
          RTRIM(sc5.C5_FORMAPG) formapg,
          RTRIM(sc5.C5_VEND1) vend1, RTRIM(sc5.C5_VEND2) vend2, RTRIM(sc5.C5_VEND3) vend3,
          ISNULL(TP6.total, 0) total_pedido,
          ISNULL(TP62.total, 0) valor_saldo,
          RTRIM(sc6.C6_FILIAL) filial,
          sc6.C6_ENTREG entreg,
          RTRIM(sc6.C6_LOCAL) armazem,
          DATEDIFF(DAY, sc5.C5_EMISSAO, sc6.C6_ENTREG) dias,
          RTRIM(sc6.C6_NUM) num,
          RTRIM(sc6.C6_NOTA) nota,
          RTRIM(sc6.C6_CLI) cli,
          RTRIM(sa1.A1_PESSOA) pessoa,
          RTRIM(sa1.A1_NOME) nome,
          RTRIM(sa1.A1_CGC) cgc,
          RTRIM(sc6.C6_ITEM) item,
          RTRIM(sc6.C6_PRODUTO) produto,
          RTRIM(sc6.C6_DESCRI) descri,
          RTRIM(sc6.C6_UM) um,
          sc6.C6_QTDVEN qtdven,
          sc6.C6_QTDENT qtdent,
          (sc6.C6_QTDVEN - sc6.C6_QTDENT) saldo,
          CAST(sc6.C6_ZPRCVEN AS DECIMAL(14,2)) unitario,
          CAST(sc6.C6_QTDVEN * sc6.C6_ZPRCVEN AS DECIMAL(14,2)) total_item,
          CAST(sc6.C6_ZPRCVEN * (sc6.C6_QTDVEN - sc6.C6_QTDENT) AS DECIMAL(14,2)) total_parcial,
          RTRIM(sc6.C6_TES) tes,
          RTRIM(sc6.C6_CF) cfop,
          RTRIM(sa1.A1_EST) uf,
          CAST(ISNULL(PRA.saldo,0) AS NUMERIC(14,2)) pago,
          CAST(ISNULL(PRF.saldo,0) AS NUMERIC(14,2)) pagar,
          CAST(ISNULL(PRA.saldo,0) + ISNULL(PRF.saldo,0) AS NUMERIC(14,2)) totalfinan,
          CAST(ISNULL(sc5.C5_ZTOTAL,0) - ISNULL(PRA.saldo,0) - ISNULL(PRF.saldo,0) AS NUMERIC(14,2)) diffinan,
          RTRIM(PE.estatus) estatus,
          ISNULL(PE.estatus_cod, 0) estatus_cod,
          RTRIM(sc5.C5_ZEXPRES) zexpres,
          RTRIM(sc5.C5_CONDPAG) condpag,
          RTRIM(cnd.E4_DESCRI) cond_desc,
          ISNULL(b2.B2_CM1, 0) b2_cm1,
          RTRIM(sc5.C5_ZGERFIN) geratp,
          CAST(ISNULL(sc5.C5_VLMINFT, 0) AS NUMERIC(14,2)) recminfat
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
        WHERE sc6.C6_FILIAL = '01'
          AND sc6.D_E_L_E_T_ <> '*' AND sc5.D_E_L_E_T_ <> '*'
          AND sb1.D_E_L_E_T_ <> '*' AND sa1.D_E_L_E_T_ <> '*'
          AND sc5.C5_FILIAL = '01'
          AND sc6.C6_CF IN (${cfopList})
          AND (sc6.C6_QTDVEN - sc6.C6_QTDENT) > 0
          AND sc6.C6_BLQ = ' '
          ${condVend}
        ORDER BY sc5.C5_ZTIPO, sc6.C6_NUM, sc6.C6_ITEM`;

      const rows = await Protheus.connectAndQuery(sql, params);

      // Pre-pass: margem por pedido = 100 - (Σcusto / ΣtotalParcial * 100)
      const pedAgg = new Map();
      rows.forEach(r => {
        const num = trim(r.num);
        const custo = N(r.b2_cm1) * N(r.saldo);
        const parcial = N(r.total_parcial);
        const a = pedAgg.get(num) || { custo: 0, parcial: 0 };
        a.parcial += parcial;
        if (custo > 0) a.custo += custo;
        pedAgg.set(num, a);
      });
      const margemPedido = (num) => { const a = pedAgg.get(num); return a && a.parcial > 0 ? 100 - (a.custo / a.parcial) * 100 : 0; };

      // ===== Monta o HTML (tabela .xls) =====
      const HEADERS = ['Tipo','Filial','Emissão','Data Entrega','Dias','Gera TP','Forma Pagto','Cond. Pagto','Pedido','Expresso','Pode Fat.Parcial','Estatus','NF','Cod.Vend','Vendedor','Cod.Vend2','Vendedor2','Cod.Vend3','Vendedor3','Cod.Cliente','TipoCli','Nome','CPF/CNPJ','Seq','Codigo','Descrição','Unidade','Quantidade','Entregue','Saldo','Unitário','Total Item','Total Parcial','Armazém','Custo Médio','% Margem Item','% Margem Pedido','Total Pedido','Saldo Pedido','Financeiro','Verifica Fin.','A Receber','Recebido','Diferença','Rec.Min.Fat','Instrução','TES','CFOP','Destino','Região','Saldo Faturado','Saldo Reposição','% Margem Total'];

      let h = `<style>
.num{mso-number-format:General;}
.dec2{mso-number-format:"0\\.00";}
.text{mso-number-format:"\\@";}
.date{mso-number-format:"mso-number-format:dd\\/mm\\/yyyy";}
</style>
<table style='font-size: 12px; font-family:monospace' border='1'>`;
      h += `<tr style='font-weight: bold'>${HEADERS.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`;

      let docNum = '';           // controla a 1a linha de cada pedido (bloco financeiro)
      let bgNum = '';            // alterna a cor de fundo por pedido
      let bg = '';
      let tot4 = 0, tot5 = 0, tot6 = 0;   // acumulados corridos (Saldo Faturado/Reposicao/% Margem Total)

      rows.forEach(r => {
        const num = trim(r.num);
        if (bgNum !== num) { bgNum = num; bg = bg === '#e0e0e0' ? '#ffffff' : '#e0e0e0'; }
        let rowBg = bg;
        if (N(r.qtdent) > 0) rowBg = '#fff5e6';   // ja teve entrega parcial

        const custoTotal = N(r.b2_cm1) * N(r.saldo);
        const totalParcial = N(r.total_parcial);
        const margemItem = custoTotal > 0 && totalParcial > 0 ? 100 - (custoTotal / totalParcial) * 100 : 0;
        const margemPed = margemPedido(num);

        // acumulados corridos
        tot4 += totalParcial;
        if (custoTotal > 0) tot5 += custoTotal;
        if (tot5 !== 0 && tot4 !== 0) tot6 = 100 - (tot5 / tot4) * 100;

        const primeira = docNum !== num;   // 1a linha do pedido?

        let c = `<tr style="background-color:${rowBg}">`;
        c += td(r.tipo_desc);
        c += td(r.filial);
        c += td(fmtData(r.emissao));
        c += td(fmtData(r.entreg));
        c += td(r.dias);
        c += td(trim(r.geratp) === 'S' ? 'Sim' : 'Não', 'text');
        c += td(formaPgto(r.formapg), 'text');
        c += td(`${trim(r.condpag)}${trim(r.cond_desc) ? ' - ' + trim(r.cond_desc) : ''}`, 'text');
        c += td(num, 'text');
        c += td(r.zexpres, 'text');
        c += td(r.zfatpar, 'text');
        c += td(r.estatus, 'text');
        c += td(r.nota, 'text');
        c += td(r.vend1, 'text');
        c += td(vendNome(r.vend1), 'text');
        c += td(r.vend2, 'text');
        c += td(vendNome(r.vend2), 'text');
        c += td(r.vend3, 'text');
        c += td(vendNome(r.vend3), 'text');
        c += td(r.cli, 'text');
        c += td(r.pessoa);
        c += td(r.nome, 'text');
        c += td(r.cgc, 'text');
        c += td(r.item, 'text');
        c += td(r.produto, 'text');
        c += td(r.descri);
        c += td(r.um);
        c += td(numBR(r.qtdven));
        c += td(numBR(r.qtdent));
        c += td(numBR(r.saldo));
        c += td(numBR(r.unitario));
        c += td(numBR(r.total_item));
        c += td(numBR(totalParcial), null, 'background:#e6f0ff');
        c += td(r.armazem);
        c += td(numBR(custoTotal));
        c += td(numBR(margemItem), null, margemItem < 10 ? 'background:#ff9900;color:white;font-weight:bold' : 'background:#e8ffe0');
        c += td(numBR(margemPed), null, margemPed < 10 ? 'background:red;color:white' : 'background:#e6f0ff');

        // Bloco pedido/financeiro — so na 1a linha do pedido
        if (primeira) {
          const totalPed = N(r.total_pedido), valorSaldo = N(r.valor_saldo);
          c += td(numBR(totalPed), null, 'color:blue');
          c += td(numBR(valorSaldo), null, totalPed !== valorSaldo ? 'color:red' : 'color:blue');
          c += td(numBR(r.totalfinan), null, 'color:black');
          const verif = (trim(r.geratp) === 'S' && N(r.diffinan) !== 0 && N(r.estatus_cod) > 1)
            ? `VERIFICAR FINANCEIRO ${numBR(r.diffinan)}` : '';
          c += td(verif, null, 'color:red;font-weight:bold');
          c += td(numBR(r.pagar), null, 'color:orange');
          c += td(numBR(r.pago), null, 'color:green');
          c += td(numBR(totalPed - N(r.pago)), null, 'color:red');
          c += td(numBR(r.recminfat), null, 'color:blue');
          const restricao = (N(r.recminfat) > 0 && N(r.recminfat) > N(r.pago)) ? 'NÃO LIBERAR TEM RESTRIÇÃO DE PAGTO' : '';
          c += td(restricao, null, 'color:red;font-weight:bold');
          docNum = num;
        } else {
          c += '<td></td>'.repeat(9);
        }

        c += td(r.tes, 'text');
        c += td(r.cfop, 'text');
        c += td(r.uf, 'text');
        c += td(regiao(r.uf), 'text');
        c += td(numBR(tot4), null, 'background:#ffe0d9');
        c += td(numBR(tot5), null, 'background:#e8ffe0');
        c += td(numBR(tot6), null, 'background:#e6f0ff');
        c += '</tr>';
        h += c;
      });

      h += '</table>';

      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="carteiradepedidos-${stamp}.xls"`);
      return res.send('﻿' + h);   // BOM + tabela HTML (Excel abre como planilha)
    } catch (err) {
      console.error('Erro vendas/carteira-detalhe:', err);
      return res.status(500).json({ message: 'Erro ao gerar o relatório: ' + err.message });
    }
  }
});

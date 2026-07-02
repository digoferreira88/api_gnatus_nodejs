// Relatorio de VENDAS (pedidos) — espelha o relatorio PHP legado
// "relatorio de vendas". Diferenca-chave do Relatorio de Faturamento:
//   - Base: SC6010 (ITENS DE PEDIDO), nao SD2 (itens de NF)
//   - Filtro: C5_EMISSAO (emissao do PEDIDO), nao D2_EMISSAO (emissao da NF)
//   - CFOPs: lista do PHP, SEM 5924 (removido — não é venda) e sem 6109
//   - Exclui itens bloqueados (C6_BLQ=' ') e tipo 'RED' (redigitacao)
//   - Traz: genero, idade, dias entre emissao/entrega, total do pedido (TP6),
//           faturado (TP2), recebido/saldo (pedidos_recebimentos), estatus
//
// Views Protheus usadas (mesmas do liberacao/DRE): total_pedido_sc6,
// total_pedido_sd2, pedidos_estatus, pedidos_recebimentos, z_genero.
//
// Parametros: ?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&vendedor=&bu=
// Mesma UX do faturamento-relatorio (perm 2002).

// CFOPs de venda do relatorio PHP (mb_split de paramValue('cfop_fat')).
// 5924 REMOVIDO (02/07/2026 — não é venda). SEM 6109 (igual ao PHP legado).
const CFOPS = [
  '5105', '5106', '5116', '5117', '5119', '5405', '5933',
  '6105', '6106', '6107', '6108', '6110', '6116', '6117',
  '6119', '6122', '6123', '6404', '6933'
];

const REGIOES = {
  Norte: ['AC', 'AM', 'AP', 'PA', 'RO', 'RR', 'TO'],
  Nordeste: ['AL', 'BA', 'CE', 'MA', 'PB', 'PE', 'PI', 'RN', 'SE'],
  CentroOeste: ['DF', 'GO', 'MT', 'MS'],
  Sudeste: ['ES', 'MG', 'RJ', 'SP'],
  Sul: ['PR', 'RS', 'SC']
};
const regiaoPorUF = {};
Object.entries(REGIOES).forEach(([regiao, ufs]) => {
  ufs.forEach((uf) => { regiaoPorUF[uf] = regiao === 'CentroOeste' ? 'Centro-Oeste' : regiao; });
});

// Forma de pagamento — mesmo mapa usado em cobranca.dashboard.js
const FORMAS_PGTO = {
  '1': 'Cheque', '2': 'Dinheiro', '3': 'Cartão', '4': 'Boleto Bancário',
  '5': 'Não informado', '6': 'Financiamento', '7': 'Cartão BNDS',
  '8': 'Bonificação', '9': 'Consignado',
  'B': 'Antecipação Parcelada', 'A': 'Futuro Garantido', '': 'Não informado'
};
const formaPgtoLabel = (cod) => FORMAS_PGTO[String(cod || '').trim()] || `Forma ${String(cod || '').trim()}`;

const toProtheusDate = (iso) => {
  if (!iso) return null;
  const s = String(iso).replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};
const toNumber = (v) => Number(v || 0);
const trim = (v) => String(v || '').trim();
const regiaoDe = (uf) => regiaoPorUF[trim(uf)] || '';

module.exports = (app) => ({
  verb: 'get',
  route: '/relatorio-vendas',

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const { inicio, fim, vendedor, bu } = req.query;

    const dtInicio = toProtheusDate(inicio);
    const dtFim = toProtheusDate(fim);
    if (!dtInicio || !dtFim) {
      return res.status(400).json({ message: 'Parâmetros inicio e fim são obrigatórios (YYYY-MM-DD).' });
    }

    const cfopList = CFOPS.map((c) => `'${c}'`).join(',');
    const condVendedor = vendedor
      ? `AND (SC5.C5_VEND1 = @vendedor OR SC5.C5_VEND2 = @vendedor OR SC5.C5_VEND3 = @vendedor)`
      : '';
    const condBu = bu
      ? `AND RTRIM(SC5.C5_ZTIPO) = @bu`
      : '';

    // Replica fielmente a query do PHP (base SC6 + total do pedido/faturado/
    // recebimentos via views). Unitario = preco * (1 + IPI%). Total item =
    // qtd vendida * unitario. Idade/genero conforme PHP.
    const sql = `
      SELECT
        RTRIM(SC5.C5_ZTIPO) AS C5_ZTIPO,
        RTRIM(SC5.C5_ZFATPAR) AS C5_ZFATPAR,
        RTRIM(SC5.C5_FORMAPG) AS C5_FORMAPG,
        SC5.C5_EMISSAO,
        RTRIM(SC5.C5_VEND1) AS C5_VEND1,
        RTRIM(SC5.C5_VEND2) AS C5_VEND2,
        RTRIM(SC5.C5_VEND3) AS C5_VEND3,
        TP6.total AS TOTAL_PEDIDO,
        TP2.total AS FATURADO,
        CAST(ISNULL(PR.PAGO, 0)  AS DECIMAL(15,2)) AS PAGO,
        CAST(ISNULL(PR.SALDO, 0) AS DECIMAL(15,2)) AS SALDO_PAGAR,
        RTRIM(SC6.C6_FILIAL) AS C6_FILIAL,
        SC6.C6_ENTREG,
        DATEDIFF(DAY, NULLIF(SC5.C5_EMISSAO, ''), NULLIF(SC6.C6_ENTREG, '')) AS DIAS,
        RTRIM(SC6.C6_NUM) AS C6_NUM,
        RTRIM(SC6.C6_NOTA) AS C6_NOTA,
        RTRIM(SC6.C6_CLI) AS C6_CLI,
        RTRIM(SA1.A1_PESSOA) AS A1_PESSOA,
        RTRIM(SA1.A1_NOME) AS A1_NOME,
        IIF(SA1.A1_DTNASC > '19000101',
            CONCAT(DATEDIFF(d, SA1.A1_DTNASC, GETDATE()) / 365, ',',
                   (DATEDIFF(d, SA1.A1_DTNASC, GETDATE()) % 365) / 30), '0') AS IDADE,
        RTRIM(SA1.A1_CGC) AS A1_CGC,
        RTRIM(SC6.C6_ITEM) AS C6_ITEM,
        RTRIM(SC6.C6_PRODUTO) AS C6_PRODUTO,
        RTRIM(SC6.C6_DESCRI) AS C6_DESCRI,
        RTRIM(SC6.C6_UM) AS C6_UM,
        SC6.C6_QTDVEN,
        SC6.C6_QTDENT,
        (SC6.C6_QTDVEN - SC6.C6_QTDENT) AS SALDO_QTD,
        ROUND((SC6.C6_PRCVEN * (1 + (SB1.B1_IPI / 100))), 2) AS UNITARIO,
        CAST((SC6.C6_QTDVEN * ROUND((SC6.C6_PRCVEN * (1 + (SB1.B1_IPI / 100))), 2)) AS DECIMAL(15,2)) AS TOTAL_ITEM,
        SC6.C6_DATFAT,
        RTRIM(SC6.C6_TES) AS C6_TES,
        RTRIM(SC6.C6_CF) AS C6_CF,
        RTRIM(SA1.A1_EST) AS A1_EST,
        RTRIM(SA1.A1_MUN) AS A1_MUN,
        CONCAT(RTRIM(SC5.C5_CONDPAG), ' - ', RTRIM(CND.E4_DESCRI)) AS CONDPAG,
        RTRIM(PE.estatus) AS ESTATUS_ITEM,
        RTRIM(SA1.A1_DDD) AS A1_DDD,
        RTRIM(SA1.A1_TEL) AS A1_TEL,
        RTRIM(SA1.A1_DDDCEL) AS A1_DDDCEL,
        RTRIM(SA1.A1_FAX) AS A1_FAX,
        IIF(SA1.A1_PESSOA = 'J', 'J', IIF(LEN(ZG.genero) > 0, ZG.genero, 'I')) AS GENERO,
        RTRIM(V1.A3_NOME) AS NOME_VEND1,
        RTRIM(V2.A3_NOME) AS NOME_VEND2, RTRIM(V2.A3_EST) AS UF_VEND2,
        RTRIM(V3.A3_NOME) AS NOME_VEND3,
        RTRIM(X5.X5_DESCRI) AS TIPO_DESC
      FROM dbo.SC6010 SC6 WITH (NOLOCK)
      LEFT JOIN dbo.SC5010 SC5 WITH (NOLOCK) ON (SC6.C6_NUM = SC5.C5_NUM)
      LEFT JOIN dbo.SA1010 SA1 WITH (NOLOCK) ON (SC5.C5_CLIENTE = SA1.A1_COD AND SC5.C5_LOJACLI = SA1.A1_LOJA)
      LEFT JOIN dbo.SB1010 SB1 WITH (NOLOCK) ON (SB1.B1_FILIAL = '' AND SC6.C6_PRODUTO = SB1.B1_COD)
      LEFT JOIN dbo.total_pedido_sc6 TP6 WITH (NOLOCK) ON (SC6.C6_NUM = TP6.c6_num)
      LEFT JOIN dbo.total_pedido_sd2 TP2 WITH (NOLOCK) ON (SC6.C6_NUM = TP2.d2_pedido)
      LEFT JOIN dbo.pedidos_estatus PE WITH (NOLOCK)
        ON (SC6.C6_FILIAL = PE.c6_filial AND SC6.C6_NUM = PE.c6_num
            AND SC6.C6_ITEM = PE.c6_item AND SC6.C6_PRODUTO = PE.c6_produto)
      LEFT JOIN dbo.pedidos_recebimentos PR WITH (NOLOCK) ON (SC6.C6_NUM = PR.E1_PEDIDO)
      LEFT JOIN dbo.SE4010 CND WITH (NOLOCK) ON (SC5.C5_CONDPAG = CND.E4_CODIGO)
      LEFT JOIN dbo.z_genero ZG
        ON (ZG.nome COLLATE Latin1_General_CI_AI =
            LEFT(SA1.A1_NOME, NULLIF(CHARINDEX(' ', SA1.A1_NOME), 0) - 1))
      LEFT JOIN dbo.SA3010 V1 WITH (NOLOCK) ON (V1.A3_COD = SC5.C5_VEND1 AND V1.D_E_L_E_T_ <> '*')
      LEFT JOIN dbo.SA3010 V2 WITH (NOLOCK) ON (V2.A3_COD = SC5.C5_VEND2 AND V2.D_E_L_E_T_ <> '*')
      LEFT JOIN dbo.SA3010 V3 WITH (NOLOCK) ON (V3.A3_COD = SC5.C5_VEND3 AND V3.D_E_L_E_T_ <> '*')
      LEFT JOIN dbo.SX5010 X5 WITH (NOLOCK)
        ON (X5.X5_TABELA = 'Z1' AND RTRIM(X5.X5_CHAVE) = RTRIM(SC5.C5_ZTIPO) AND ISNULL(X5.D_E_L_E_T_, ' ') = ' ')
      WHERE
        SC5.C5_FILIAL = '01'
        AND SC5.C5_EMISSAO >= @inicio
        AND SC5.C5_EMISSAO <= @fim
        AND SC5.D_E_L_E_T_ <> '*'
        AND SC6.D_E_L_E_T_ <> '*'
        AND SB1.D_E_L_E_T_ <> '*'
        AND SA1.D_E_L_E_T_ <> '*'
        AND SC6.C6_CF IN (${cfopList})
        AND SC6.C6_BLQ = ' '
        AND SC5.C5_ZTIPO NOT IN ('RED')
        ${condVendedor}
        ${condBu}
      ORDER BY SC5.C5_ZTIPO, SC5.C5_VEND1, SC6.C6_NUM, SC6.C6_ITEM
    `;

    // BUs disponiveis no periodo (pro dropdown, sem aplicar o filtro de BU).
    // Soma o TOTAL_ITEM (c6_valor) — metrica de venda por pedido.
    const sqlBus = `
      SELECT RTRIM(SC5.C5_ZTIPO) codigo,
             MAX(RTRIM(X5.X5_DESCRI)) label,
             SUM(CAST((SC6.C6_QTDVEN * ROUND((SC6.C6_PRCVEN * (1 + (SB1.B1_IPI / 100))), 2)) AS DECIMAL(15,2))) total
        FROM dbo.SC6010 SC6 WITH (NOLOCK)
        LEFT JOIN dbo.SC5010 SC5 WITH (NOLOCK) ON (SC6.C6_NUM = SC5.C5_NUM)
        LEFT JOIN dbo.SB1010 SB1 WITH (NOLOCK) ON (SB1.B1_FILIAL = '' AND SC6.C6_PRODUTO = SB1.B1_COD)
        LEFT JOIN dbo.SX5010 X5 WITH (NOLOCK)
          ON (X5.X5_TABELA = 'Z1' AND RTRIM(X5.X5_CHAVE) = RTRIM(SC5.C5_ZTIPO) AND ISNULL(X5.D_E_L_E_T_, ' ') = ' ')
       WHERE SC5.C5_FILIAL = '01'
         AND SC5.C5_EMISSAO >= @inicio AND SC5.C5_EMISSAO <= @fim
         AND SC5.D_E_L_E_T_ <> '*' AND SC6.D_E_L_E_T_ <> '*' AND SB1.D_E_L_E_T_ <> '*'
         AND SC6.C6_CF IN (${cfopList})
         AND SC6.C6_BLQ = ' '
         AND SC5.C5_ZTIPO NOT IN ('RED')
       GROUP BY SC5.C5_ZTIPO
       ORDER BY SUM(CAST((SC6.C6_QTDVEN * ROUND((SC6.C6_PRCVEN * (1 + (SB1.B1_IPI / 100))), 2)) AS DECIMAL(15,2))) DESC
    `;

    try {
      const params = { inicio: dtInicio, fim: dtFim };
      if (vendedor) params.vendedor = String(vendedor);
      if (bu) params.bu = String(bu).trim();

      const [rows, busRows] = await Promise.all([
        Protheus.connectAndQuery(sql, params),
        Protheus.connectAndQuery(sqlBus, { inicio: dtInicio, fim: dtFim })
      ]);

      // Os totais de PEDIDO (total/faturado/recebido/saldo) sao iguais pra todos
      // os itens do mesmo pedido — no PHP eram mostrados so na 1a linha. Aqui
      // marcamos `primeiroDoPedido` pra o frontend exibir uma vez (e nao somar
      // duplicado nas agregacoes).
      const pedidosVistos = new Set();

      const dados = rows.map((r) => {
        const uf = trim(r.A1_EST);
        const ufVend2 = trim(r.UF_VEND2);
        const totalPedido = toNumber(r.TOTAL_PEDIDO);
        const faturado = toNumber(r.FATURADO);
        const pago = toNumber(r.PAGO);
        const saldoPagar = toNumber(r.SALDO_PAGAR);
        const pedido = trim(r.C6_NUM);
        const primeiroDoPedido = !pedidosVistos.has(pedido);
        if (primeiroDoPedido) pedidosVistos.add(pedido);

        // regiao do representante (vend2): se tem vend2, usa a UF dele; senao a do cliente
        const temVend2 = trim(r.C5_VEND2) > '000000';
        const regiaoRep = temVend2 ? regiaoDe(ufVend2) : regiaoDe(uf);

        return {
          tipo: trim(r.TIPO_DESC) || trim(r.C5_ZTIPO),
          tipoCodigo: trim(r.C5_ZTIPO),
          filial: trim(r.C6_FILIAL),
          emissao: trim(r.C5_EMISSAO),
          dataEntrega: trim(r.C6_ENTREG),
          dias: r.DIAS == null ? null : toNumber(r.DIAS),
          formaPgto: formaPgtoLabel(r.C5_FORMAPG),
          formaPgtoCod: trim(r.C5_FORMAPG),
          condPag: trim(r.CONDPAG),
          pedido,
          parcial: trim(r.C5_ZFATPAR),
          estatus: trim(r.ESTATUS_ITEM),
          nf: trim(r.C6_NOTA),
          codVendedor: trim(r.C5_VEND1),
          vendedor: trim(r.NOME_VEND1),
          codVendedor2: trim(r.C5_VEND2),
          vendedor2: trim(r.NOME_VEND2),
          codVendedor3: trim(r.C5_VEND3),
          vendedor3: trim(r.NOME_VEND3),
          codCliente: trim(r.C6_CLI),
          tipoPessoa: trim(r.A1_PESSOA),
          cliente: trim(r.A1_NOME),
          genero: trim(r.GENERO),
          idade: trim(r.IDADE),
          cnpj: trim(r.A1_CGC),
          sequencia: trim(r.C6_ITEM),
          produto: trim(r.C6_PRODUTO),
          descricao: trim(r.C6_DESCRI),
          unidade: trim(r.C6_UM),
          quantidade: toNumber(r.C6_QTDVEN),
          entregue: toNumber(r.C6_QTDENT),
          saldo: toNumber(r.SALDO_QTD),
          unitario: toNumber(r.UNITARIO),
          totalItem: toNumber(r.TOTAL_ITEM),
          // Valores de PEDIDO (so no 1o item do pedido; 0 nos demais)
          primeiroDoPedido,
          totalPedido: primeiroDoPedido ? totalPedido : 0,
          totalFaturado: primeiroDoPedido ? faturado : 0,
          saldoFaturar: primeiroDoPedido ? (totalPedido - faturado) : 0,
          recebido: primeiroDoPedido ? pago : 0,
          saldoReceber: primeiroDoPedido ? saldoPagar : 0,
          residuoFinanceiro: primeiroDoPedido ? ((saldoPagar + pago) - faturado) : 0,
          tes: trim(r.C6_TES),
          cfop: trim(r.C6_CF),
          destino: uf,
          regiao: regiaoDe(uf),
          ufVend2,
          regiaoRep,
          municipio: trim(r.A1_MUN),
          dataFaturamento: trim(r.C6_DATFAT),
          ddd: trim(r.A1_DDD),
          telefone: trim(r.A1_TEL),
          dddCel: trim(r.A1_DDDCEL),
          fax: trim(r.A1_FAX)
        };
      });

      return res.json({
        periodo: { inicio: dtInicio, fim: dtFim },
        filtros: {
          vendedor: vendedor ? String(vendedor) : null,
          bu: bu ? String(bu).trim() : null
        },
        bus: busRows.map((b) => ({
          codigo: trim(b.codigo),
          label: trim(b.label) || trim(b.codigo) || '—',
          total: toNumber(b.total)
        })),
        totalRegistros: dados.length,
        dados
      });
    } catch (error) {
      console.error('Erro no relatório de vendas:', error);
      return res.status(500).json({ message: 'Erro ao gerar relatório de vendas.' });
    }
  }
});

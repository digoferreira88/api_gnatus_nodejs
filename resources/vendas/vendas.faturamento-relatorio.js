const CFOPS = [
  '5105', '5106', '5116', '5117', '5119', '5405', '5933',
  '6105', '6106', '6107', '6108', '6109', '6110', '6116', '6117',
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

const toProtheusDate = (iso) => {
  if (!iso) return null;
  const s = String(iso).replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};

const toNumber = (v) => Number(v || 0);
const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/faturamento-relatorio',

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const { inicio, fim, vendedor, bu, cliente } = req.query;

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
    // Cliente: aceita codigo exato (6 digitos) OU prefixo (LIKE).
    const condCliente = cliente
      ? `AND SD2.D2_CLIENTE LIKE @cliente + '%'`
      : '';

    const sql = `
      SELECT
        SC5.C5_ZTIPO, SC5.C5_ZFATPAR, SC5.C5_FORMAPG, SC5.C5_EMISSAO,
        SC6.C6_ENTREG, SF2.F2_VALBRUT,
        SD2.D2_FILIAL, SD2.D2_EMISSAO, RTRIM(SD2.D2_DOC) AS D2_DOC,
        RTRIM(SD2.D2_PEDIDO) AS D2_PEDIDO, RTRIM(SD2.D2_CLIENTE) AS D2_CLIENTE,
        SD2.D2_ITEM, RTRIM(SD2.D2_COD) AS D2_COD, SD2.D2_LOCAL, SD2.D2_UM,
        SD2.D2_QUANT, SD2.D2_QTDEDEV, SD2.D2_PRCVEN, SD2.D2_VALBRUT,
        (SD2.D2_VALBRUT - SD2.D2_VALDEV) AS D2_TOTAL,
        SD2.D2_TES, SD2.D2_CF, SD2.D2_EST,
        SD2.D2_BASEICM, SD2.D2_PICM, SD2.D2_VALICM,
        SD2.D2_BASEIPI, SD2.D2_IPI, SD2.D2_VALIPI,
        SD2.D2_BASIMP6, SD2.D2_ALQIMP6, SD2.D2_VALIMP6,
        SD2.D2_BASIMP5, SD2.D2_ALQIMP5, SD2.D2_VALIMP5,
        SD2.D2_VALFRE, SD2.D2_CUSTO1 AS CUSTO_TOTAL,
        SD2.D2_BASEISS, SD2.D2_ALIQISS, SD2.D2_VALISS,
        SD2.D2_DIFAL, SD2.D2_ICMSDIF, SD2.D2_VFCPDIF, SD2.D2_VOPDIF,
        RTRIM(SA3.A3_COD) AS A3_COD, RTRIM(SA3.A3_NOME) AS A3_NOME,
        RTRIM(SA31.A3_COD) AS CODVEN2, RTRIM(SA31.A3_NOME) AS NOMEVEN2,
        RTRIM(SA1.A1_PESSOA) AS A1_PESSOA, RTRIM(SA1.A1_NOME) AS A1_NOME,
        RTRIM(SA1.A1_CGC) AS A1_CGC, RTRIM(SA1.A1_NREDUZ) AS A1_NREDUZ,
        RTRIM(SA1.A1_DDD) AS A1_DDD, RTRIM(SA1.A1_TEL) AS A1_TEL,
        RTRIM(SA1.A1_DDDCEL) AS A1_DDDCEL, RTRIM(SA1.A1_FAX) AS A1_FAX,
        RTRIM(SA1.A1_EMAIL) AS A1_EMAIL, RTRIM(SA1.A1_MUN) AS A1_MUN,
        RTRIM(SA1.A1_EST) AS A1_EST,
        RTRIM(SB1.B1_DESC) AS B1_DESC, RTRIM(SB1.B1_POSIPI) AS B1_POSIPI,
        RTRIM(SZ1.Z1_ZNUMSER) AS Z1_ZNUMSER, SZ1.Z1_EXPEDIC,
        DATEDIFF(DAY, SD2.D2_EMISSAO, SZ1.Z1_EXPEDIC) AS DIASEXPED,
        RTRIM(SZ1.Z1_RASTREI) AS Z1_RASTREI,
        PRA.SALDO AS PAGO, PRF.SALDO AS PAGAR,
        CONCAT(RTRIM(SC5.C5_CONDPAG), ' - ', RTRIM(CND.E4_DESCRI)) AS CONDPAG,
        RTRIM(X5TIPO.X5_DESCRI) AS TIPO_PEDIDO_DESC,
        CASE
          WHEN SC9.C9_PEDIDO IS NULL THEN '10 Aguardando liberação do Comercial'
          WHEN SC9.C9_BLEST = '' AND SC9.C9_BLCRED = '01' THEN '20 Aguardando liberação do Financeiro'
          WHEN SC9.C9_BLEST = '02' AND SC9.C9_BLCRED = '01' THEN '20 Aguardando liberação do Financeiro'
          WHEN SC9.C9_BLCRED = '09' THEN '25 Financeiro Bloqueado'
          WHEN SC9.C9_BLEST IN ('','02') AND SC9.C9_BLCRED = '80' THEN '30 Aguardando Planejamento'
          WHEN SC9.C9_BLEST IN ('','02') AND SC9.C9_BLCRED = '90' THEN '40 Formulação Financeira'
          WHEN SC9.C9_BLEST = '02' AND SC9.C9_BLCRED = '' THEN '50 Liberação de Estoque'
          WHEN SC9.C9_BLCRED = '' AND SC9.C9_BLEST = '' THEN '60 Aguardando Faturamento'
          WHEN SC9.C9_BLCRED = '10' AND SC9.C9_BLEST = '10' THEN '99 Totalmente Faturado'
          ELSE 'Desconhecido'
        END AS STATUS_PEDIDO
      FROM SD2010 SD2 WITH (NOLOCK)
      LEFT JOIN SF2010 SF2 WITH (NOLOCK)
        ON SF2.F2_FILIAL = SD2.D2_FILIAL
       AND SF2.F2_DOC    = SD2.D2_DOC
       AND SF2.F2_SERIE  = SD2.D2_SERIE
       AND ISNULL(SF2.D_E_L_E_T_, ' ') = ' '
      LEFT JOIN SZ1010 SZ1 WITH (NOLOCK)
        ON SZ1.Z1_FILIAL = SD2.D2_FILIAL
       AND SZ1.Z1_DOC    = SD2.D2_DOC
       AND SZ1.Z1_ITEM   = SD2.D2_ITEM
       AND SZ1.Z1_COD    = SD2.D2_COD
       AND ISNULL(SZ1.D_E_L_E_T_, ' ') = ' '
      LEFT JOIN SC5010 SC5 WITH (NOLOCK)
        ON SC5.C5_FILIAL = SD2.D2_FILIAL
       AND SC5.C5_NUM    = SD2.D2_PEDIDO
       AND ISNULL(SC5.D_E_L_E_T_, ' ') = ' '
      LEFT JOIN SC6010 SC6 WITH (NOLOCK)
        ON SC6.C6_FILIAL = SD2.D2_FILIAL
       AND SC6.C6_NUM    = SD2.D2_PEDIDO
       AND SC6.C6_ITEM   = SD2.D2_ITEM
       AND ISNULL(SC6.D_E_L_E_T_, ' ') = ' '
      OUTER APPLY (
        SELECT TOP 1 SC9.C9_PEDIDO, SC9.C9_BLEST, SC9.C9_BLCRED
        FROM SC9010 SC9 WITH (NOLOCK)
        WHERE SC9.C9_FILIAL  = SC6.C6_FILIAL
          AND SC9.C9_PEDIDO  = SC6.C6_NUM
          AND SC9.C9_ITEM    = SC6.C6_ITEM
          AND SC9.C9_PRODUTO = SC6.C6_PRODUTO
          AND SC9.D_E_L_E_T_ = ' '
        ORDER BY SC9.R_E_C_N_O_ DESC
      ) SC9
      LEFT JOIN SA3010 SA3 WITH (NOLOCK)
        ON SA3.A3_COD = SC5.C5_VEND1
       AND ISNULL(SA3.D_E_L_E_T_, ' ') = ' '
      LEFT JOIN SA3010 SA31 WITH (NOLOCK)
        ON SA31.A3_COD = SC5.C5_VEND2
       AND ISNULL(SA31.D_E_L_E_T_, ' ') = ' '
      LEFT JOIN SA1010 SA1 WITH (NOLOCK)
        ON SA1.A1_COD  = SD2.D2_CLIENTE
       AND SA1.A1_LOJA = SD2.D2_LOJA
       AND ISNULL(SA1.D_E_L_E_T_, ' ') = ' '
      LEFT JOIN SB1010 SB1 WITH (NOLOCK)
        ON SB1.B1_FILIAL = ''
       AND SB1.B1_COD    = SD2.D2_COD
       AND ISNULL(SB1.D_E_L_E_T_, ' ') = ' '
      LEFT JOIN faturamento_ra PRA WITH (NOLOCK)
        ON PRA.NF = SD2.D2_DOC
      LEFT JOIN faturamento_rf PRF WITH (NOLOCK)
        ON PRF.NF = SD2.D2_DOC
      LEFT JOIN SE4010 CND WITH (NOLOCK)
        ON CND.E4_CODIGO = SC5.C5_CONDPAG
       AND ISNULL(CND.D_E_L_E_T_, ' ') = ' '
      LEFT JOIN SX5010 X5TIPO WITH (NOLOCK)
        ON X5TIPO.X5_TABELA = 'Z1'
       AND RTRIM(X5TIPO.X5_CHAVE) = RTRIM(SC5.C5_ZTIPO)
       AND ISNULL(X5TIPO.D_E_L_E_T_, ' ') = ' '
      WHERE
        ISNULL(SD2.D_E_L_E_T_, ' ') = ' '
        AND SD2.D2_FILIAL = '01'
        AND SD2.D2_CF IN (${cfopList})
        AND SD2.D2_EMISSAO BETWEEN @inicio AND @fim
        ${condVendedor}
        ${condBu}
        ${condCliente}
      ORDER BY SD2.D2_EMISSAO, SD2.D2_DOC, SD2.D2_ITEM
    `;

    try {
      const params = { inicio: dtInicio, fim: dtFim };
      if (vendedor) params.vendedor = String(vendedor);
      if (bu)       params.bu       = String(bu).trim();
      if (cliente)  params.cliente  = String(cliente).trim();

      // BUs disponiveis no periodo (sem aplicar filtro de BU, pro dropdown
      // listar todas as opcoes independente do filtro ativo).
      const sqlBus = `
        SELECT RTRIM(SC5.C5_ZTIPO) codigo,
               MAX(RTRIM(X5.X5_DESCRI)) label,
               SUM(SD2.D2_VALBRUT - SD2.D2_VALDEV) total
          FROM SD2010 SD2 WITH (NOLOCK)
          LEFT JOIN SC5010 SC5 WITH (NOLOCK)
            ON SC5.C5_FILIAL = SD2.D2_FILIAL AND SC5.C5_NUM = SD2.D2_PEDIDO
           AND ISNULL(SC5.D_E_L_E_T_, ' ') = ' '
          LEFT JOIN SX5010 X5 WITH (NOLOCK)
            ON X5.X5_TABELA = 'Z1' AND RTRIM(X5.X5_CHAVE) = RTRIM(SC5.C5_ZTIPO)
           AND ISNULL(X5.D_E_L_E_T_, ' ') = ' '
         WHERE ISNULL(SD2.D_E_L_E_T_, ' ') = ' '
           AND SD2.D2_FILIAL = '01'
           AND SD2.D2_CF IN (${cfopList})
           AND SD2.D2_EMISSAO BETWEEN @inicio AND @fim
         GROUP BY SC5.C5_ZTIPO
         ORDER BY SUM(SD2.D2_VALBRUT - SD2.D2_VALDEV) DESC`;

      const [rows, busRows] = await Promise.all([
        Protheus.connectAndQuery(sql, params),
        Protheus.connectAndQuery(sqlBus, { inicio: dtInicio, fim: dtFim })
      ]);

      // Pós-processamento: totais por documento, margens, região
      const porDocumento = {};
      rows.forEach((r) => {
        const doc = trim(r.D2_DOC);
        if (!porDocumento[doc]) {
          porDocumento[doc] = { totalItem: 0, totalCusto: 0 };
        }
        porDocumento[doc].totalItem += toNumber(r.D2_TOTAL);
        porDocumento[doc].totalCusto += toNumber(r.CUSTO_TOTAL);
      });

      const dados = rows.map((r) => {
        const quant = toNumber(r.D2_QUANT);
        const devolvido = toNumber(r.D2_QTDEDEV);
        const valBrut = toNumber(r.D2_VALBRUT);
        const custo = toNumber(r.CUSTO_TOTAL);
        const total = toNumber(r.D2_TOTAL);
        const unitario = quant !== 0 ? valBrut / quant : 0;
        const novaQtd = quant - devolvido;
        const novoTotal = unitario * novaQtd;
        const margemItem = total > 0 && custo > 0 ? 100 - (custo / total) * 100 : 0;
        const doc = trim(r.D2_DOC);
        const tot = porDocumento[doc] || { totalItem: 0, totalCusto: 0 };
        const margemTotal = tot.totalItem !== 0 && tot.totalCusto !== 0
          ? 100 - (tot.totalCusto / tot.totalItem) * 100
          : 0;
        const pago = toNumber(r.PAGO);
        const pagar = toNumber(r.PAGAR);
        const f2Val = toNumber(r.F2_VALBRUT);
        const diferenca = f2Val - (pago + pagar);
        const uf = trim(r.D2_EST);

        return {
          tipo: trim(r.TIPO_PEDIDO_DESC) || trim(r.C5_ZTIPO),
          tipoCodigo: trim(r.C5_ZTIPO),
          filial: trim(r.D2_FILIAL),
          emissao: trim(r.D2_EMISSAO),
          expedicao: trim(r.Z1_EXPEDIC),
          diasExped: toNumber(r.DIASEXPED),
          nf: trim(r.D2_DOC),
          cfop: trim(r.D2_CF),
          formaPgto: trim(r.C5_FORMAPG),
          condPag: trim(r.CONDPAG),
          pedido: trim(r.D2_PEDIDO),
          parcial: trim(r.C5_ZFATPAR),
          codVendedor: trim(r.A3_COD),
          vendedor: trim(r.A3_NOME),
          codVendedor2: trim(r.CODVEN2),
          vendedor2: trim(r.NOMEVEN2),
          codCliente: trim(r.D2_CLIENTE),
          tipoPessoa: trim(r.A1_PESSOA),
          cliente: trim(r.A1_NOME),
          cnpj: trim(r.A1_CGC),
          sequencia: trim(r.D2_ITEM),
          produto: trim(r.D2_COD),
          descricao: trim(r.B1_DESC),
          unidade: trim(r.D2_UM),
          ncm: trim(r.B1_POSIPI),
          numSerie: trim(r.Z1_ZNUMSER),
          rastreio: trim(r.Z1_RASTREI),
          quantidade: quant,
          devolvido,
          unitario,
          totalItem: novoTotal,
          armazem: trim(r.D2_LOCAL),
          custoMedio: custo,
          margemItem,
          margemTotal,
          totalNF: f2Val,
          recebido: pago,
          aReceber: pagar,
          diferenca,
          tes: trim(r.D2_TES),
          destino: uf,
          regiao: regiaoPorUF[uf] || '',
          baseIcms: toNumber(r.D2_BASEICM),
          aliqIcms: toNumber(r.D2_PICM),
          valorIcms: toNumber(r.D2_VALICM),
          baseIpi: toNumber(r.D2_BASEIPI),
          aliqIpi: toNumber(r.D2_IPI),
          valorIpi: toNumber(r.D2_VALIPI),
          basePis: toNumber(r.D2_BASIMP6),
          aliqPis: toNumber(r.D2_ALQIMP6),
          valorPis: toNumber(r.D2_VALIMP6),
          baseCofins: toNumber(r.D2_BASIMP5),
          aliqCofins: toNumber(r.D2_ALQIMP5),
          valorCofins: toNumber(r.D2_VALIMP5),
          valorFrete: toNumber(r.D2_VALFRE),
          conferencia: Math.round(diferenca) !== 0 ? 'Verificar' : '',
          saldoFaturado: tot.totalItem,
          saldoReposicao: tot.totalCusto,
          nomeReduzido: trim(r.A1_NREDUZ),
          ddd: trim(r.A1_DDD),
          telefone: trim(r.A1_TEL),
          dddCel: trim(r.A1_DDDCEL),
          telefone2: trim(r.A1_FAX),
          email: trim(r.A1_EMAIL),
          municipio: trim(r.A1_MUN),
          estado: trim(r.A1_EST),
          baseIss: toNumber(r.D2_BASEISS),
          aliqIss: toNumber(r.D2_ALIQISS),
          valorIss: toNumber(r.D2_VALISS),
          valorDifal: toNumber(r.D2_DIFAL),
          icmsDif: toNumber(r.D2_ICMSDIF),
          fcpDif: toNumber(r.D2_VFCPDIF),
          outrosDifal: toNumber(r.D2_VOPDIF),
          emissaoPedido: trim(r.C5_EMISSAO),
          dataEntrega: trim(r.C6_ENTREG),
          statusPedido: trim(r.STATUS_PEDIDO)
        };
      });

      return res.json({
        periodo: { inicio: dtInicio, fim: dtFim },
        filtros: {
          vendedor: vendedor ? String(vendedor) : null,
          bu: bu ? String(bu).trim() : null,
          cliente: cliente ? String(cliente).trim() : null
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
      console.error('Erro no relatório de faturamento:', error);
      return res.status(500).json({ message: 'Erro ao gerar relatório de faturamento.' });
    }
  }
});

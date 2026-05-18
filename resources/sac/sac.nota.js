const trim = (v) => String(v || '').trim();
const toNumber = (v) => Number(v || 0);

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6001, 6002]);

module.exports = (app) => ({
  verb: 'get',
  route: '/nota',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const doc = trim(req.query.doc);
    const serie = trim(req.query.serie);
    const tipo = (trim(req.query.tipo) || 'saida').toLowerCase();

    if (!doc) {
      return res.status(400).json({ message: 'Parâmetro doc é obrigatório.' });
    }

    const params = { doc, serie };

    // Query para NF de saída (SF2 + SD2) e entrada (SF1 + SD1)
    const sqlSaida = `
      SELECT
        RTRIM(f2.F2_DOC) AS numero,
        RTRIM(f2.F2_SERIE) AS serie,
        f2.F2_EMISSAO AS emissao,
        RTRIM(f2.F2_TIPO) AS tipo,
        RTRIM(f2.F2_ESPECIE) AS especie,
        RTRIM(f2.F2_CHVNFE) AS chaveNFe,
        RTRIM(f2.F2_STATUS) AS statusSefaz,
        RTRIM(f2.F2_CLIENTE) AS codCliente,
        RTRIM(f2.F2_LOJA) AS lojaCliente,
        RTRIM(sa1.A1_NOME) AS nomeCliente,
        RTRIM(sa1.A1_CGC) AS cgcCliente,
        RTRIM(sa1.A1_MUN) AS municipio,
        RTRIM(sa1.A1_EST) AS estado,
        f2.F2_VALBRUT AS valorBruto,
        f2.F2_VALMERC AS valorMerc,
        f2.F2_VALICM AS valorICMS,
        f2.F2_VALIPI AS valorIPI,
        f2.F2_FRETE AS frete,
        f2.F2_SEGURO AS seguro,
        f2.F2_DESPESA AS despesa,
        f2.F2_DESCONT AS desconto,
        RTRIM(f2.F2_COND) AS condPag,
        RTRIM(e4.E4_DESCRI) AS condPagDescri,
        RTRIM(f2.F2_TRANSP) AS transportadora,
        RTRIM(sa4.A4_NOME) AS transpNome
      FROM SF2010 f2 WITH (NOLOCK)
      LEFT JOIN SA1010 sa1 WITH (NOLOCK)
        ON sa1.A1_COD = f2.F2_CLIENTE AND sa1.A1_LOJA = f2.F2_LOJA
       AND sa1.D_E_L_E_T_ <> '*'
      LEFT JOIN SE4010 e4 WITH (NOLOCK)
        ON e4.E4_CODIGO = f2.F2_COND AND e4.D_E_L_E_T_ <> '*'
      LEFT JOIN SA4010 sa4 WITH (NOLOCK)
        ON sa4.A4_COD = f2.F2_TRANSP AND sa4.D_E_L_E_T_ <> '*'
      WHERE f2.D_E_L_E_T_ <> '*'
        AND RTRIM(f2.F2_DOC) = @doc
        ${serie ? 'AND RTRIM(f2.F2_SERIE) = @serie' : ''}
    `;

    const sqlSaidaItens = `
      SELECT
        RTRIM(d2.D2_ITEM) AS item,
        RTRIM(d2.D2_COD) AS produto,
        RTRIM(sb1.B1_DESC) AS descricao,
        RTRIM(d2.D2_UM) AS unidade,
        RTRIM(d2.D2_CF) AS cfop,
        d2.D2_QUANT AS quantidade,
        d2.D2_QTDEDEV AS devolvido,
        d2.D2_PRCVEN AS precoUnit,
        d2.D2_TOTAL AS total,
        d2.D2_VALBRUT AS valorBruto,
        d2.D2_VALDEV AS valorDevolvido,
        d2.D2_DESCON AS desconto,
        d2.D2_VALICM AS valorICMS,
        d2.D2_PICM AS aliqICMS,
        d2.D2_VALIPI AS valorIPI,
        d2.D2_IPI AS aliqIPI,
        d2.D2_VALIMP5 AS valorCofins,
        d2.D2_ALQIMP5 AS aliqCofins,
        d2.D2_VALIMP6 AS valorPis,
        d2.D2_ALQIMP6 AS aliqPis
      FROM SD2010 d2 WITH (NOLOCK)
      LEFT JOIN SB1010 sb1 WITH (NOLOCK)
        ON sb1.B1_COD = d2.D2_COD AND sb1.D_E_L_E_T_ <> '*'
      WHERE d2.D_E_L_E_T_ <> '*'
        AND RTRIM(d2.D2_DOC) = @doc
        ${serie ? 'AND RTRIM(d2.D2_SERIE) = @serie' : ''}
      ORDER BY d2.D2_ITEM
    `;

    const sqlEntrada = `
      SELECT
        RTRIM(f1.F1_DOC) AS numero,
        RTRIM(f1.F1_SERIE) AS serie,
        f1.F1_EMISSAO AS emissao,
        RTRIM(f1.F1_TIPO) AS tipo,
        RTRIM(f1.F1_ESPECIE) AS especie,
        RTRIM(f1.F1_CHVNFE) AS chaveNFe,
        RTRIM(f1.F1_STATUS) AS statusSefaz,
        RTRIM(f1.F1_FORNECE) AS codCliente,
        RTRIM(f1.F1_LOJA) AS lojaCliente,
        RTRIM(sa1.A1_NOME) AS nomeCliente,
        RTRIM(sa1.A1_CGC) AS cgcCliente,
        RTRIM(sa1.A1_MUN) AS municipio,
        RTRIM(sa1.A1_EST) AS estado,
        f1.F1_VALBRUT AS valorBruto,
        f1.F1_VALMERC AS valorMerc,
        f1.F1_VALICM AS valorICMS,
        f1.F1_VALIPI AS valorIPI,
        f1.F1_FRETE AS frete,
        f1.F1_SEGURO AS seguro,
        f1.F1_DESPESA AS despesa,
        f1.F1_DESCONT AS desconto,
        RTRIM(f1.F1_COND) AS condPag,
        RTRIM(e4.E4_DESCRI) AS condPagDescri,
        RTRIM(f1.F1_NFORIG) AS notaOriginal,
        RTRIM(f1.F1_SERORIG) AS serieOriginal
      FROM SF1010 f1 WITH (NOLOCK)
      LEFT JOIN SA1010 sa1 WITH (NOLOCK)
        ON sa1.A1_COD = f1.F1_FORNECE AND sa1.A1_LOJA = f1.F1_LOJA
       AND sa1.D_E_L_E_T_ <> '*'
      LEFT JOIN SE4010 e4 WITH (NOLOCK)
        ON e4.E4_CODIGO = f1.F1_COND AND e4.D_E_L_E_T_ <> '*'
      WHERE f1.D_E_L_E_T_ <> '*'
        AND RTRIM(f1.F1_DOC) = @doc
        ${serie ? 'AND RTRIM(f1.F1_SERIE) = @serie' : ''}
    `;

    const sqlEntradaItens = `
      SELECT
        RTRIM(d1.D1_ITEM) AS item,
        RTRIM(d1.D1_COD) AS produto,
        RTRIM(sb1.B1_DESC) AS descricao,
        RTRIM(d1.D1_UM) AS unidade,
        RTRIM(d1.D1_CF) AS cfop,
        d1.D1_QUANT AS quantidade,
        0 AS devolvido,
        d1.D1_VUNIT AS precoUnit,
        d1.D1_TOTAL AS total,
        d1.D1_VUNIT * d1.D1_QUANT AS valorBruto,
        0 AS valorDevolvido,
        d1.D1_VALDESC AS desconto,
        d1.D1_VALICM AS valorICMS,
        d1.D1_PICM AS aliqICMS,
        d1.D1_VALIPI AS valorIPI,
        d1.D1_IPI AS aliqIPI,
        d1.D1_VALIMP5 AS valorCofins,
        d1.D1_ALQIMP5 AS aliqCofins,
        d1.D1_VALIMP6 AS valorPis,
        d1.D1_ALQIMP6 AS aliqPis
      FROM SD1010 d1 WITH (NOLOCK)
      LEFT JOIN SB1010 sb1 WITH (NOLOCK)
        ON sb1.B1_COD = d1.D1_COD AND sb1.D_E_L_E_T_ <> '*'
      WHERE d1.D_E_L_E_T_ <> '*'
        AND RTRIM(d1.D1_DOC) = @doc
        ${serie ? 'AND RTRIM(d1.D1_SERIE) = @serie' : ''}
      ORDER BY d1.D1_ITEM
    `;

    try {
      const [headerRows, itens] = await Promise.all([
        Protheus.connectAndQuery(tipo === 'entrada' ? sqlEntrada : sqlSaida, params),
        Protheus.connectAndQuery(tipo === 'entrada' ? sqlEntradaItens : sqlSaidaItens, params)
      ]);

      if (headerRows.length === 0) {
        return res.status(404).json({ message: 'Nota não encontrada.' });
      }

      const h = headerRows[0];
      return res.json({
        tipo,
        numero: trim(h.numero),
        serie: trim(h.serie),
        emissao: trim(h.emissao),
        especie: trim(h.especie),
        tipoNota: trim(h.tipo),
        chaveNFe: trim(h.chaveNFe),
        statusSefaz: trim(h.statusSefaz),
        cliente: {
          codigo: trim(h.codCliente),
          loja: trim(h.lojaCliente),
          nome: trim(h.nomeCliente),
          cgc: trim(h.cgcCliente),
          municipio: trim(h.municipio),
          estado: trim(h.estado)
        },
        condPag: trim(h.condPag),
        condPagDescri: trim(h.condPagDescri),
        transportadora: trim(h.transportadora || ''),
        transpNome: trim(h.transpNome || ''),
        notaOriginal: trim(h.notaOriginal || ''),
        serieOriginal: trim(h.serieOriginal || ''),
        totais: {
          valorBruto: toNumber(h.valorBruto),
          valorMerc: toNumber(h.valorMerc),
          valorICMS: toNumber(h.valorICMS),
          valorIPI: toNumber(h.valorIPI),
          frete: toNumber(h.frete),
          seguro: toNumber(h.seguro),
          despesa: toNumber(h.despesa),
          desconto: toNumber(h.desconto)
        },
        itens: itens.map((i) => ({
          item: trim(i.item),
          produto: trim(i.produto),
          descricao: trim(i.descricao),
          unidade: trim(i.unidade),
          cfop: trim(i.cfop),
          quantidade: toNumber(i.quantidade),
          devolvido: toNumber(i.devolvido),
          precoUnit: toNumber(i.precoUnit),
          total: toNumber(i.total),
          valorBruto: toNumber(i.valorBruto),
          valorDevolvido: toNumber(i.valorDevolvido),
          desconto: toNumber(i.desconto),
          valorICMS: toNumber(i.valorICMS),
          aliqICMS: toNumber(i.aliqICMS),
          valorIPI: toNumber(i.valorIPI),
          aliqIPI: toNumber(i.aliqIPI),
          valorCofins: toNumber(i.valorCofins),
          aliqCofins: toNumber(i.aliqCofins),
          valorPis: toNumber(i.valorPis),
          aliqPis: toNumber(i.aliqPis)
        }))
      });
    } catch (error) {
      console.error('Erro em sac/nota:', error);
      return res.status(500).json({ message: 'Erro ao consultar nota fiscal.' });
    }
  }
});

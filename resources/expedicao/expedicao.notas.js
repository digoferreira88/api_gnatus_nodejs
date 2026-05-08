// Notas fiscais a expedir: SF2010 ainda não expedidas (z1_expedic IS NULL),
// filial 01, série 1, emissão após 2020-03-01, exclui CFOPs que não entram
// na expedição física (5118/6118/5119/6119/5934/5905/5922/6922).
// Enriquece com flag `noBordero` consultando tab_exp_bordero da Intranet.

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/notas',

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;
    const dataMinima = trim(req.query.dataMinima) || '20200301';
    const busca = trim(req.query.busca).toUpperCase();

    const params = { dataMinima };
    const conds = [];
    if (busca) {
      params.busca = busca;
      conds.push(`AND (UPPER(sa1.A1_NOME) LIKE '%' + @busca + '%' OR f2.F2_DOC LIKE @busca + '%' OR f2.F2_CLIENTE LIKE @busca + '%')`);
    }

    // SX3 da Gnatus: DIFAL = SD2.D2_DIFAL ; FCP Proprio = SD2.D2_VALFECP.
    // Nao ha campo agregado em SF2 — somamos por NF via subquery.
    const sql = `
      SELECT
        RTRIM(f2.F2_DOC)     nfe,
        RTRIM(f2.F2_SERIE)   serie,
        f2.F2_EMISSAO        emissao,
        RTRIM(f2.F2_CLIENTE) clienteCod,
        RTRIM(f2.F2_LOJA)    clienteLoja,
        RTRIM(sa1.A1_NOME)   clienteNome,
        RTRIM(sa1.A1_CGC)    clienteCnpj,
        RTRIM(sa1.A1_END)    clienteEnd,
        RTRIM(sa1.A1_BAIRRO) clienteBairro,
        RTRIM(sa1.A1_MUN)    clienteMun,
        RTRIM(sa1.A1_EST)    clienteUf,
        RTRIM(sa1.A1_CEP)    clienteCep,
        RTRIM(sa1.A1_EMAIL)  clienteEmail,
        f2.F2_VOLUME1        volumes,
        RTRIM(f2.F2_TRANSP)  transpCod,
        RTRIM(sa4.A4_NOME)   transpNome,
        fe.z1_expedic        zExpedic,
        RTRIM(fe.z1_rastrei) zRastrei,
        f2.F2_VALMERC        total,
        ISNULL(imp.difal, 0) difal,
        ISNULL(imp.fcp, 0)   fcp,
        f2.R_E_C_N_O_        id
      FROM SF2010 f2 WITH (NOLOCK)
      LEFT JOIN SA1010 sa1 WITH (NOLOCK)
        ON f2.F2_CLIENTE = sa1.A1_COD AND f2.F2_LOJA = sa1.A1_LOJA
       AND sa1.D_E_L_E_T_ <> '*'
      LEFT JOIN faturamento_expedicao fe
        ON fe.z1_filial = f2.F2_FILIAL
       AND fe.z1_doc    = f2.F2_DOC
       AND fe.z1_serie  = f2.F2_SERIE
      LEFT JOIN SA4010 sa4 WITH (NOLOCK)
        ON f2.F2_TRANSP = sa4.A4_COD AND sa4.D_E_L_E_T_ <> '*'
      LEFT JOIN (
        SELECT D2_FILIAL, D2_DOC, D2_SERIE, D2_CLIENTE, D2_LOJA,
               SUM(D2_DIFAL)   difal,
               SUM(D2_VALFECP) fcp
          FROM SD2010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*'
         GROUP BY D2_FILIAL, D2_DOC, D2_SERIE, D2_CLIENTE, D2_LOJA
      ) imp
        ON imp.D2_FILIAL  = f2.F2_FILIAL
       AND imp.D2_DOC     = f2.F2_DOC
       AND imp.D2_SERIE   = f2.F2_SERIE
       AND imp.D2_CLIENTE = f2.F2_CLIENTE
       AND imp.D2_LOJA    = f2.F2_LOJA
      WHERE f2.F2_FILIAL = '01'
        AND f2.D_E_L_E_T_ <> '*'
        AND f2.F2_SERIE = '1'
        AND f2.F2_EMISSAO > @dataMinima
        AND fe.z1_expedic IS NULL
        AND (sa1.A1_COD IS NULL OR sa1.D_E_L_E_T_ <> '*')
        -- Exclui NF que NAO tenha NENHUM item com CFOP de expedicao fisica.
        -- Antes era LEFT JOIN faturamento_cfop, mas a view agrupa por CFOP
        -- e a NF aparecia N vezes quando tinha mais de um CFOP (ex 6105+6106).
        -- EXISTS retorna 0/1 sem multiplicar linhas.
        AND EXISTS (
          SELECT 1 FROM faturamento_cfop fc
           WHERE fc.d2_filial = f2.F2_FILIAL
             AND fc.d2_doc    = f2.F2_DOC
             AND fc.d2_serie  = f2.F2_SERIE
             AND fc.d2_cf NOT IN ('5118','6118','5119','6119','5934','5905','5922','6922')
        )
        ${conds.join(' ')}
      ORDER BY f2.F2_EMISSAO DESC, f2.F2_DOC DESC
    `;

    try {
      const rows = await Protheus.connectAndQuery(sql, params);

      // Coleta as NFs que já estão no bordero
      const nfsNoBordero = new Set();
      try {
        const borderoRows = await Pg.connectAndQuery(
          `SELECT DISTINCT NOTAFISCAL FROM tab_exp_bordero`, {}
        );
        borderoRows.forEach(r => nfsNoBordero.add(trim(r.NOTAFISCAL)));
      } catch (e) { console.warn('Expedição/notas: falha ao ler bordero', e.message); }

      const notas = rows.map(r => ({
        id: r.id,
        nfe: trim(r.nfe),
        serie: trim(r.serie),
        emissao: trim(r.emissao),
        clienteCod: trim(r.clienteCod),
        clienteLoja: trim(r.clienteLoja),
        clienteNome: trim(r.clienteNome),
        clienteCnpj: trim(r.clienteCnpj),
        clienteEnd: trim(r.clienteEnd),
        clienteBairro: trim(r.clienteBairro),
        clienteMun: trim(r.clienteMun),
        clienteUf: trim(r.clienteUf),
        clienteCep: trim(r.clienteCep),
        clienteEmail: trim(r.clienteEmail),
        volumes: toN(r.volumes),
        transpCod: trim(r.transpCod),
        transpNome: trim(r.transpNome),
        zExpedic: trim(r.zExpedic),
        zRastrei: trim(r.zRastrei),
        total: toN(r.total),
        difal: toN(r.difal),
        fcp: toN(r.fcp),
        noBordero: nfsNoBordero.has(trim(r.nfe))
      }));

      return res.json({
        totalRegistros: notas.length,
        totalNoBordero: notas.filter(n => n.noBordero).length,
        notas,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro expedicao/notas:', err);
      return res.status(500).json({ message: 'Erro ao consultar notas a expedir.' });
    }
  }
});

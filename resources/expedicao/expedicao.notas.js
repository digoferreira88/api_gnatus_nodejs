// Notas fiscais a expedir: SF2010 ainda não expedidas (z1_expedic IS NULL),
// filial 01, série 1, emissão após 2020-03-01, exclui CFOPs que não entram
// na expedição física (5118/6118/5119/6119/5934/5905/5922/6922).
// Enriquece com flag `noBordero` consultando tab_exp_bordero da Intranet.
//
// CATEGORIZAÇÃO DO DIFAL (campo `difalCategoria`):
//   - 'SEM_DIFAL'        : difal == 0
//   - 'ST_MENSAL'        : difal > 0 E UF do destinatário tem IE Gnatus → apuração
//                          mensal por substituição tributária (Clara não paga diário)
//   - 'INDEVIDO_CONTRIB' : difal > 0 E cliente é CONTRIBUINTE (A1_CONTRIB != '2') →
//                          provável erro de cadastro/TES no Protheus (DIFAL EC 87/2015
//                          é só pra não contribuinte) — auditar no caso a caso
//   - 'DIARIO'           : difal > 0 E não contribuinte E UF sem IE Gnatus → DIFAL real
//                          que a Clara precisa pagar/recolher diariamente
//
// O contador "Só com DIFAL" do frontend agora considera só DIARIO.

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

// UFs onde a Gnatus tem IE como Substituto Tributário — DIFAL é apurado
// mensalmente, não NF a NF. Lista informada pelo financeiro em 2026-05-27.
// Se mudar, atualizar aqui e fazer deploy (não há tabela de config ainda).
const UFS_IE_GNATUS = new Set(['AM', 'CE', 'DF', 'PR', 'MA', 'MG', 'RJ', 'SC']);

const classificarDifal = (difal, uf, contrib) => {
  if (!(Number(difal) > 0)) return 'SEM_DIFAL';
  if (UFS_IE_GNATUS.has(trim(uf).toUpperCase())) return 'ST_MENSAL';
  // A1_CONTRIB: '1' = contribuinte, '2' = não contribuinte, '9' = isento.
  // DIFAL EC 87/2015 / LC 190/2022: só destinatário NÃO contribuinte (= '2').
  if (trim(contrib) !== '2') return 'INDEVIDO_CONTRIB';
  return 'DIARIO';
};

module.exports = (app) => ({
  verb: 'get',
  route: '/notas',

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;
    const dataMinima = trim(req.query.dataMinima) || '20200301';
    const busca = trim(req.query.busca).toUpperCase();
    // 3 abas:
    //   pendentes     -> sem expedicao registrada (default, comportamento legado)
    //   sem_rastreio  -> expedida mas sem numero de rastreio
    //   expedidas     -> expedida + com rastreio
    const ABAS_VALIDAS = new Set(['pendentes', 'sem_rastreio', 'expedidas']);
    const aba = ABAS_VALIDAS.has(req.query.aba) ? req.query.aba : 'pendentes';

    const params = { dataMinima };
    const conds = [];
    if (busca) {
      params.busca = busca;
      conds.push(`AND (UPPER(sa1.A1_NOME) LIKE '%' + @busca + '%' OR f2.F2_DOC LIKE @busca + '%' OR f2.F2_CLIENTE LIKE @busca + '%')`);
    }

    // Filtro principal por aba
    let condAba;
    if (aba === 'sem_rastreio') {
      condAba = `AND fe.z1_expedic IS NOT NULL AND (fe.z1_rastrei IS NULL OR RTRIM(fe.z1_rastrei) = '')`;
    } else if (aba === 'expedidas') {
      condAba = `AND fe.z1_expedic IS NOT NULL AND fe.z1_rastrei IS NOT NULL AND RTRIM(fe.z1_rastrei) <> ''`;
    } else {
      condAba = `AND fe.z1_expedic IS NULL`;
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
        RTRIM(sa1.A1_CONTRIB) clienteContrib,
        RTRIM(sa1.A1_INSCR)   clienteInscr,
        f2.F2_VOLUME1        volumes,
        RTRIM(f2.F2_TRANSP)  transpCod,
        RTRIM(sa4.A4_NOME)   transpNome,
        fe.z1_expedic        zExpedic,
        RTRIM(fe.z1_rastrei) zRastrei,
        f2.F2_VALMERC        total,
        ISNULL(imp.difal, 0) difal,
        ISNULL(imp.fcp, 0)   fcp,
        -- Pedido(s) de venda da NF (SD2.D2_PEDIDO). Normalmente 1 por NF; se houver
        -- mais de um, concatena os distintos ("123, 124"). Ignora itens sem pedido.
        STUFF((SELECT DISTINCT ', ' + RTRIM(sd2p.D2_PEDIDO)
                 FROM SD2010 sd2p WITH (NOLOCK)
                WHERE sd2p.D2_FILIAL  = f2.F2_FILIAL
                  AND sd2p.D2_DOC     = f2.F2_DOC
                  AND sd2p.D2_SERIE   = f2.F2_SERIE
                  AND sd2p.D2_CLIENTE = f2.F2_CLIENTE
                  AND sd2p.D2_LOJA    = f2.F2_LOJA
                  AND sd2p.D_E_L_E_T_ <> '*'
                  AND RTRIM(sd2p.D2_PEDIDO) <> ''
                FOR XML PATH('')), 1, 2, '') pedido,
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
        ${condAba}
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

      const notas = rows.map(r => {
        const difal = toN(r.difal);
        const uf    = trim(r.clienteUf);
        const contrib = trim(r.clienteContrib);
        return {
          id: r.id,
          nfe: trim(r.nfe),
          serie: trim(r.serie),
          pedido: trim(r.pedido),
          emissao: trim(r.emissao),
          clienteCod: trim(r.clienteCod),
          clienteLoja: trim(r.clienteLoja),
          clienteNome: trim(r.clienteNome),
          clienteCnpj: trim(r.clienteCnpj),
          clienteEnd: trim(r.clienteEnd),
          clienteBairro: trim(r.clienteBairro),
          clienteMun: trim(r.clienteMun),
          clienteUf: uf,
          clienteCep: trim(r.clienteCep),
          clienteEmail: trim(r.clienteEmail),
          clienteContrib: contrib,           // '1'=contrib, '2'=nao contrib, '9'=isento
          clienteInscr: trim(r.clienteInscr),
          volumes: toN(r.volumes),
          transpCod: trim(r.transpCod),
          transpNome: trim(r.transpNome),
          zExpedic: trim(r.zExpedic),
          zRastrei: trim(r.zRastrei),
          total: toN(r.total),
          difal,
          fcp: toN(r.fcp),
          difalCategoria: classificarDifal(difal, uf, contrib),
          noBordero: nfsNoBordero.has(trim(r.nfe))
        };
      });

      return res.json({
        aba,
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

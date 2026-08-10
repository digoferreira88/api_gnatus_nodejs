const trim = (v) => String(v || '').trim();
const toNumber = (v) => Number(v || 0);
const Estatus = require('../../services/vendasEstatus');

// Status do pedido. Fonte PRIMÁRIA = view `pedidos_estatus` (MENOR estatus_cod
// entre os itens = gargalo real), a MESMA do espelho e do Planejamento — assim a
// lista do SAC e o espelho nunca divergem.
// ⚠️ Antes decidia só por C5_LIBEROK='S' e dizia "Liberado p/ faturar" mesmo com
// o estoque bloqueado (C9_BLEST) — foi o caso do pedido 093068 (crédito liberado,
// estoque em '02', estatus 50). O fallback por cabeçalho só vale quando o pedido
// não está na view (ex.: outra filial / fora do escopo da view).
const calcStatusPedido = (r, estCod) => {
  if (estCod != null && String(estCod).trim() !== '') {
    const inf = Estatus.info(estCod);
    return { codigo: `E${inf.cod}`, label: inf.label, cor: inf.cor };
  }
  const quje = toNumber(r.C6_QTDENT);
  const quant = toNumber(r.C6_QTDVEN);
  const blq = trim(r.C6_BLQ);
  const liberok = trim(r.C5_LIBEROK);
  if (blq === 'R') return { codigo: 'BLOQUEADO', label: 'Bloqueado', cor: '#c9302c' };
  if (quant > 0 && quje >= quant) return { codigo: 'FATURADO', label: 'Totalmente faturado', cor: '#1e5fb5' };
  if (quje > 0) return { codigo: 'PARCIAL', label: 'Faturamento parcial', cor: '#f5a500' };
  if (liberok === 'S') return { codigo: 'LIBERADO', label: 'Liberado p/ faturar', cor: '#09A013' };
  return { codigo: 'ABERTO', label: 'Em aberto', cor: '#5b9bd5' };
};

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6001, 6002]);

module.exports = (app) => ({
  verb: 'get',
  route: '/cliente',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const codigo = trim(req.query.codigo);
    const loja = trim(req.query.loja);

    if (!codigo || !loja) {
      return res.status(400).json({ message: 'Parâmetros codigo e loja são obrigatórios.' });
    }

    const params = { codigo, loja };

    // --- 1. Cadastro (SA1010) ---
    const sqlCadastro = `
      SELECT
        RTRIM(a1.A1_COD)     AS codigo,
        RTRIM(a1.A1_LOJA)    AS loja,
        RTRIM(a1.A1_NOME)    AS nome,
        RTRIM(a1.A1_NREDUZ)  AS nomeReduzido,
        RTRIM(a1.A1_CGC)     AS cgc,
        RTRIM(a1.A1_PESSOA)  AS tipoPessoa,
        RTRIM(a1.A1_END)     AS endereco,
        RTRIM(a1.A1_BAIRRO)  AS bairro,
        RTRIM(a1.A1_MUN)     AS municipio,
        RTRIM(a1.A1_EST)     AS estado,
        RTRIM(a1.A1_CEP)     AS cep,
        RTRIM(a1.A1_DDD)     AS ddd,
        RTRIM(a1.A1_TEL)     AS telefone,
        RTRIM(a1.A1_DDDCEL)  AS dddCel,
        RTRIM(a1.A1_EMAIL)   AS email,
        RTRIM(a1.A1_CONTATO) AS contato,
        RTRIM(a1.A1_ATIVIDA) AS atividade,
        RTRIM(a1.A1_VEND)    AS vendedor,
        RTRIM(sa3.A3_NOME)   AS vendedorNome,
        RTRIM(a1.A1_COND)    AS condPag,
        RTRIM(e4.E4_DESCRI)  AS condPagDescri,
        a1.A1_LC             AS limiteCredito,
        a1.A1_RISCO          AS risco,
        RTRIM(a1.A1_CLASSE)  AS classe,
        RTRIM(a1.A1_MSBLQL)  AS bloqueado,
        a1.A1_DTCAD          AS dataCadastro,
        a1.A1_ULTCOM         AS ultimaCompra,
        a1.A1_PRICOM         AS primeiraCompra,
        a1.A1_NROCOM         AS numeroCompras
      FROM SA1010 a1 WITH (NOLOCK)
      LEFT JOIN SA3010 sa3 WITH (NOLOCK)
        ON sa3.A3_COD = a1.A1_VEND AND sa3.D_E_L_E_T_ <> '*'
      LEFT JOIN SE4010 e4 WITH (NOLOCK)
        ON e4.E4_CODIGO = a1.A1_COND AND e4.D_E_L_E_T_ <> '*'
      WHERE a1.D_E_L_E_T_ <> '*'
        AND a1.A1_COD  = @codigo
        AND a1.A1_LOJA = @loja
    `;

    // --- 2. Resumo / KPIs (agregados últimos 12 meses) ---
    const sqlResumo = `
      DECLARE @hoje12m VARCHAR(8) = CONVERT(VARCHAR(8), DATEADD(MONTH, -12, GETDATE()), 112);
      SELECT
        (SELECT COUNT(DISTINCT f2.F2_DOC)
         FROM SF2010 f2 WITH (NOLOCK)
         WHERE f2.D_E_L_E_T_ <> '*'
           AND f2.F2_CLIENTE = @codigo AND f2.F2_LOJA = @loja
           AND f2.F2_EMISSAO >= @hoje12m) AS qtdNotas12m,
        (SELECT ISNULL(SUM(d2.D2_VALBRUT - d2.D2_VALDEV), 0)
         FROM SD2010 d2 WITH (NOLOCK)
         WHERE d2.D_E_L_E_T_ <> '*'
           AND d2.D2_CLIENTE = @codigo AND d2.D2_LOJA = @loja
           AND d2.D2_EMISSAO >= @hoje12m) AS totalFaturado12m,
        (SELECT ISNULL(SUM(e1.E1_SALDO), 0)
         FROM SE1010 e1 WITH (NOLOCK)
         WHERE e1.D_E_L_E_T_ <> '*'
           AND e1.E1_CLIENTE = @codigo AND e1.E1_LOJA = @loja
           AND e1.E1_SALDO > 0) AS saldoAberto,
        (SELECT COUNT(*)
         FROM SE1010 e1 WITH (NOLOCK)
         WHERE e1.D_E_L_E_T_ <> '*'
           AND e1.E1_CLIENTE = @codigo AND e1.E1_LOJA = @loja
           AND e1.E1_SALDO > 0
           AND e1.E1_VENCREA < CONVERT(VARCHAR(8), GETDATE(), 112)) AS titulosAtrasados,
        (SELECT COUNT(*)
         FROM SC5010 c5 WITH (NOLOCK)
         WHERE c5.D_E_L_E_T_ <> '*'
           AND c5.C5_CLIENTE = @codigo AND c5.C5_LOJACLI = @loja
           AND c5.C5_EMISSAO >= @hoje12m) AS qtdPedidos12m
    `;

    // --- 3. Pedidos de Venda (últimos 24 meses) ---
    const sqlPedidos = `
      SELECT TOP 200
        RTRIM(c5.C5_NUM)     AS numero,
        c5.C5_EMISSAO        AS emissao,
        RTRIM(c5.C5_TIPO)    AS tipo,
        RTRIM(c5.C5_ZTIPO)   AS ztipo,
        RTRIM(x5.X5_DESCRI)  AS ztipoDescri,
        RTRIM(c5.C5_VEND1)   AS vendedor,
        RTRIM(sa3.A3_NOME)   AS vendedorNome,
        RTRIM(c5.C5_CONDPAG) AS condPag,
        RTRIM(c5.C5_MENNOTA) AS obs,
        RTRIM(c5.C5_LIBEROK) AS C5_LIBEROK,
        (SELECT SUM(c6.C6_VALOR)
         FROM SC6010 c6 WITH (NOLOCK)
         WHERE c6.C6_FILIAL = c5.C5_FILIAL
           AND c6.C6_NUM = c5.C5_NUM
           AND c6.D_E_L_E_T_ <> '*') AS valorTotal,
        (SELECT COUNT(*)
         FROM SC6010 c6 WITH (NOLOCK)
         WHERE c6.C6_FILIAL = c5.C5_FILIAL
           AND c6.C6_NUM = c5.C5_NUM
           AND c6.D_E_L_E_T_ <> '*') AS qtdItens,
        (SELECT SUM(c6.C6_QTDVEN) FROM SC6010 c6 WITH (NOLOCK)
          WHERE c6.C6_FILIAL = c5.C5_FILIAL AND c6.C6_NUM = c5.C5_NUM
            AND c6.D_E_L_E_T_ <> '*') AS C6_QTDVEN,
        (SELECT SUM(c6.C6_QTDENT) FROM SC6010 c6 WITH (NOLOCK)
          WHERE c6.C6_FILIAL = c5.C5_FILIAL AND c6.C6_NUM = c5.C5_NUM
            AND c6.D_E_L_E_T_ <> '*') AS C6_QTDENT,
        (SELECT TOP 1 RTRIM(c6.C6_BLQ) FROM SC6010 c6 WITH (NOLOCK)
          WHERE c6.C6_FILIAL = c5.C5_FILIAL AND c6.C6_NUM = c5.C5_NUM
            AND c6.D_E_L_E_T_ <> '*' AND c6.C6_BLQ <> ' ' ORDER BY c6.C6_ITEM) AS C6_BLQ
      FROM SC5010 c5 WITH (NOLOCK)
      LEFT JOIN SA3010 sa3 WITH (NOLOCK)
        ON sa3.A3_COD = c5.C5_VEND1 AND sa3.D_E_L_E_T_ <> '*'
      LEFT JOIN SX5010 x5 WITH (NOLOCK)
        ON x5.X5_TABELA = 'Z1' AND RTRIM(x5.X5_CHAVE) = RTRIM(c5.C5_ZTIPO)
       AND x5.D_E_L_E_T_ <> '*'
      WHERE c5.D_E_L_E_T_ <> '*'
        AND c5.C5_CLIENTE = @codigo
        AND c5.C5_LOJACLI = @loja
        AND c5.C5_EMISSAO >= CONVERT(VARCHAR(8), DATEADD(MONTH, -24, GETDATE()), 112)
      ORDER BY c5.C5_EMISSAO DESC, c5.C5_NUM DESC
    `;

    // --- 3b. Estatus (gargalo) por pedido — MESMA view do espelho/Planejamento.
    // MIN(estatus_cod) por pedido = etapa travada (ex.: 50 = estoque). Alinha a
    // lista ao espelho. Falha da view é NÃO-FATAL (cai no status por cabeçalho).
    const sqlEstatus = `
      SELECT RTRIM(pe.c6_num) AS numero, MIN(pe.estatus_cod) AS estatusCod
        FROM pedidos_estatus pe
       WHERE pe.c6_filial = '01'
         AND pe.c6_num IN (
           SELECT c5.C5_NUM FROM SC5010 c5 WITH (NOLOCK)
            WHERE c5.D_E_L_E_T_ <> '*'
              AND c5.C5_CLIENTE = @codigo AND c5.C5_LOJACLI = @loja
              AND c5.C5_EMISSAO >= CONVERT(VARCHAR(8), DATEADD(MONTH, -24, GETDATE()), 112))
       GROUP BY pe.c6_num
    `;

    // --- 4. Notas Fiscais emitidas (últimos 24 meses) ---
    const sqlNotas = `
      SELECT TOP 200
        RTRIM(f2.F2_DOC)     AS numero,
        RTRIM(f2.F2_SERIE)   AS serie,
        f2.F2_EMISSAO        AS emissao,
        RTRIM(f2.F2_TIPO)    AS tipo,
        RTRIM(f2.F2_ESPECIE) AS especie,
        RTRIM(f2.F2_CHVNFE)  AS chaveNFe,
        f2.F2_VALBRUT        AS valorBruto,
        f2.F2_VALMERC        AS valorMerc,
        f2.F2_VALICM         AS valorICMS,
        f2.F2_VALIPI         AS valorIPI,
        RTRIM(f2.F2_STATUS)  AS statusSefaz,
        (SELECT ISNULL(SUM(d2.D2_VALDEV), 0)
         FROM SD2010 d2 WITH (NOLOCK)
         WHERE d2.D2_FILIAL = f2.F2_FILIAL
           AND d2.D2_DOC   = f2.F2_DOC
           AND d2.D2_SERIE = f2.F2_SERIE
           AND d2.D_E_L_E_T_ <> '*') AS valorDevolvido,
        (SELECT COUNT(*)
         FROM SD2010 d2 WITH (NOLOCK)
         WHERE d2.D2_FILIAL = f2.F2_FILIAL
           AND d2.D2_DOC   = f2.F2_DOC
           AND d2.D2_SERIE = f2.F2_SERIE
           AND d2.D_E_L_E_T_ <> '*') AS qtdItens
      FROM SF2010 f2 WITH (NOLOCK)
      WHERE f2.D_E_L_E_T_ <> '*'
        AND f2.F2_CLIENTE = @codigo
        AND f2.F2_LOJA    = @loja
        AND f2.F2_EMISSAO >= CONVERT(VARCHAR(8), DATEADD(MONTH, -24, GETDATE()), 112)
      ORDER BY f2.F2_EMISSAO DESC, f2.F2_DOC DESC
    `;

    // --- 5. Devoluções (NF de entrada com CFOP 1202/2202 + fornecedor = cliente) ---
    const sqlDevolucoes = `
      SELECT
        RTRIM(f1.F1_DOC)     AS numero,
        RTRIM(f1.F1_SERIE)   AS serie,
        f1.F1_EMISSAO        AS emissao,
        RTRIM(f1.F1_TIPO)    AS tipo,
        RTRIM(f1.F1_ESPECIE) AS especie,
        RTRIM(f1.F1_CHVNFE)  AS chaveNFe,
        f1.F1_VALBRUT        AS valorBruto,
        f1.F1_VALMERC        AS valorMerc,
        RTRIM(f1.F1_NFORIG)  AS notaOriginal,
        RTRIM(f1.F1_SERORIG) AS serieOriginal,
        (SELECT COUNT(DISTINCT d1.D1_ITEM)
         FROM SD1010 d1 WITH (NOLOCK)
         WHERE d1.D1_FILIAL = f1.F1_FILIAL
           AND d1.D1_DOC    = f1.F1_DOC
           AND d1.D1_SERIE  = f1.F1_SERIE
           AND d1.D_E_L_E_T_ <> '*') AS qtdItens,
        (SELECT TOP 1 RTRIM(d1.D1_CF)
         FROM SD1010 d1 WITH (NOLOCK)
         WHERE d1.D1_FILIAL = f1.F1_FILIAL
           AND d1.D1_DOC    = f1.F1_DOC
           AND d1.D1_SERIE  = f1.F1_SERIE
           AND d1.D_E_L_E_T_ <> '*'
         ORDER BY d1.D1_ITEM) AS cfop
      FROM SF1010 f1 WITH (NOLOCK)
      WHERE f1.D_E_L_E_T_ <> '*'
        AND f1.F1_FORNECE = @codigo
        AND f1.F1_LOJA    = @loja
        AND EXISTS (
          SELECT 1 FROM SD1010 d1 WITH (NOLOCK)
          WHERE d1.D1_FILIAL = f1.F1_FILIAL
            AND d1.D1_DOC    = f1.F1_DOC
            AND d1.D1_SERIE  = f1.F1_SERIE
            AND d1.D_E_L_E_T_ <> '*'
            AND d1.D1_CF IN ('1202','2202','1411','2411','1553','2553')
        )
        AND f1.F1_EMISSAO >= CONVERT(VARCHAR(8), DATEADD(MONTH, -24, GETDATE()), 112)
      ORDER BY f1.F1_EMISSAO DESC
    `;

    // --- 6. Financeiro (SE1) — últimos 12 meses ---
    const sqlFinanceiro = `
      SELECT TOP 300
        RTRIM(e1.E1_PREFIXO) AS prefixo,
        RTRIM(e1.E1_NUM)     AS numero,
        RTRIM(e1.E1_PARCELA) AS parcela,
        RTRIM(e1.E1_TIPO)    AS tipo,
        RTRIM(e1.E1_NATUREZ) AS natureza,
        e1.E1_EMISSAO        AS emissao,
        e1.E1_VENCTO         AS vencimento,
        e1.E1_VENCREA        AS vencimentoReal,
        e1.E1_BAIXA          AS dataBaixa,
        e1.E1_VALOR          AS valor,
        e1.E1_SALDO          AS saldo,
        e1.E1_VALLIQ         AS valorLiquido,
        e1.E1_MULTA          AS multa,
        e1.E1_JUROS          AS juros,
        e1.E1_DESCONT        AS desconto,
        RTRIM(e1.E1_HIST)    AS historico,
        DATEDIFF(day, CONVERT(date, e1.E1_VENCREA, 112), GETDATE()) AS diasAtraso
      FROM SE1010 e1 WITH (NOLOCK)
      WHERE e1.D_E_L_E_T_ <> '*'
        AND e1.E1_CLIENTE = @codigo
        AND e1.E1_LOJA    = @loja
        AND (
          e1.E1_SALDO > 0
          OR e1.E1_BAIXA >= CONVERT(VARCHAR(8), DATEADD(MONTH, -12, GETDATE()), 112)
        )
      ORDER BY e1.E1_EMISSAO DESC, e1.E1_VENCTO DESC
    `;

    try {
      const [cadastroRows, resumoRows, pedidos, estatusRows, notas, devolucoes, financeiro] = await Promise.all([
        Protheus.connectAndQuery(sqlCadastro, params),
        Protheus.connectAndQuery(sqlResumo, params),
        Protheus.connectAndQuery(sqlPedidos, params),
        Protheus.connectAndQuery(sqlEstatus, params).catch((e) => { console.warn('sac/cliente estatus indisponível:', e.message); return []; }),
        Protheus.connectAndQuery(sqlNotas, params),
        Protheus.connectAndQuery(sqlDevolucoes, params),
        Protheus.connectAndQuery(sqlFinanceiro, params)
      ]);

      if (cadastroRows.length === 0) {
        return res.status(404).json({ message: 'Cliente não encontrado.' });
      }

      const cadastro = cadastroRows[0];
      const resumo = resumoRows[0] || {};
      const estatusMap = new Map((estatusRows || []).map((e) => [trim(e.numero), e.estatusCod]));

      const ticketMedio = toNumber(resumo.qtdNotas12m) > 0
        ? toNumber(resumo.totalFaturado12m) / toNumber(resumo.qtdNotas12m)
        : 0;

      return res.json({
        cadastro: {
          ...cadastro,
          limiteCredito: toNumber(cadastro.limiteCredito),
          risco: trim(cadastro.risco),
          numeroCompras: toNumber(cadastro.numeroCompras),
          dataCadastro: trim(cadastro.dataCadastro),
          ultimaCompra: trim(cadastro.ultimaCompra),
          primeiraCompra: trim(cadastro.primeiraCompra)
        },
        resumo: {
          qtdNotas12m: toNumber(resumo.qtdNotas12m),
          totalFaturado12m: toNumber(resumo.totalFaturado12m),
          saldoAberto: toNumber(resumo.saldoAberto),
          titulosAtrasados: toNumber(resumo.titulosAtrasados),
          qtdPedidos12m: toNumber(resumo.qtdPedidos12m),
          ticketMedio
        },
        pedidos: pedidos.map((r) => ({
          numero: trim(r.numero),
          emissao: trim(r.emissao),
          tipo: trim(r.tipo),
          ztipoDescri: trim(r.ztipoDescri) || trim(r.ztipo),
          vendedor: trim(r.vendedor),
          vendedorNome: trim(r.vendedorNome),
          condPag: trim(r.condPag),
          obs: trim(r.obs),
          valorTotal: toNumber(r.valorTotal),
          qtdItens: toNumber(r.qtdItens),
          status: calcStatusPedido(r, estatusMap.get(trim(r.numero)))
        })),
        notas: notas.map((r) => ({
          numero: trim(r.numero),
          serie: trim(r.serie),
          emissao: trim(r.emissao),
          tipo: trim(r.tipo),
          especie: trim(r.especie),
          chaveNFe: trim(r.chaveNFe),
          valorBruto: toNumber(r.valorBruto),
          valorMerc: toNumber(r.valorMerc),
          valorICMS: toNumber(r.valorICMS),
          valorIPI: toNumber(r.valorIPI),
          valorDevolvido: toNumber(r.valorDevolvido),
          statusSefaz: trim(r.statusSefaz),
          qtdItens: toNumber(r.qtdItens)
        })),
        devolucoes: devolucoes.map((r) => ({
          numero: trim(r.numero),
          serie: trim(r.serie),
          emissao: trim(r.emissao),
          tipo: trim(r.tipo),
          especie: trim(r.especie),
          chaveNFe: trim(r.chaveNFe),
          valorBruto: toNumber(r.valorBruto),
          valorMerc: toNumber(r.valorMerc),
          notaOriginal: trim(r.notaOriginal),
          serieOriginal: trim(r.serieOriginal),
          cfop: trim(r.cfop),
          qtdItens: toNumber(r.qtdItens)
        })),
        financeiro: financeiro.map((r) => ({
          prefixo: trim(r.prefixo),
          numero: trim(r.numero),
          parcela: trim(r.parcela),
          tipo: trim(r.tipo),
          natureza: trim(r.natureza),
          emissao: trim(r.emissao),
          vencimento: trim(r.vencimento),
          vencimentoReal: trim(r.vencimentoReal),
          dataBaixa: trim(r.dataBaixa),
          valor: toNumber(r.valor),
          saldo: toNumber(r.saldo),
          valorLiquido: toNumber(r.valorLiquido),
          multa: toNumber(r.multa),
          juros: toNumber(r.juros),
          desconto: toNumber(r.desconto),
          historico: trim(r.historico),
          diasAtraso: toNumber(r.diasAtraso)
        })),
        geradoEm: new Date().toISOString()
      });
    } catch (error) {
      console.error('Erro em sac/cliente:', error);
      return res.status(500).json({ message: 'Erro ao consultar perfil do cliente.' });
    }
  }
});

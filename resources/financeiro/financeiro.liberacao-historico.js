// GET /financeiro/liberacao-historico?inicio=YYYYMMDD&fim=YYYYMMDD&tipo=&formaPgto=&busca=&status=
//
// Histórico de liberações: pedidos que JÁ saíram da fila do financeiro — ou seja,
// passaram da etapa "Aguardando liberação do Financeiro" (estatus 20) para frente
// (30 Planejamento, 40 Formulação, 50 Liberação Estoque, 60 Aguardando Faturamento,
// 99 Faturado). A liberação em si continua manual no Protheus; aqui só LEMOS o
// resultado (SC9 via view pedidos_estatus). Data de liberação = último C9_DATALIB.
//
// Período (default: últimos 30 dias) filtra pela data da última liberação.
// Permissão 8006.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006]);

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

const FORMAS_PGTO = {
  '1': 'Cheque', '2': 'Dinheiro', '3': 'Cartão', '4': 'Boleto Bancário',
  '5': 'Não informado', '6': 'Financiamento', '7': 'Cartão BNDS',
  '8': 'Bonificação', '9': 'Consignado', 'B': 'Antecipação Parcelada',
  'A': 'Futuro Garantido', '': 'Não informado'
};
const descreverFormaPgto = (cod) => FORMAS_PGTO[cod] || `Forma ${cod}`;

// estatus_cod > 20 (já liberado pelo financeiro). 25 = bloqueado financeiro (fica fora).
const STATUS_LABEL = {
  30: 'Aguardando Planejamento', 40: 'Formulação Financeira', 50: 'Liberação de Estoque',
  60: 'Aguardando Faturamento', 99: 'Faturado'
};
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

module.exports = (app) => ({
  verb: 'get',
  route: '/liberacao-historico',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const hoje = new Date();
    const inicio = /^\d{8}$/.test(trim(req.query.inicio)) ? trim(req.query.inicio) : ymd(new Date(hoje.getTime() - 30 * 864e5));
    const fim = /^\d{8}$/.test(trim(req.query.fim)) ? trim(req.query.fim) : ymd(hoje);
    const tipo = trim(req.query.tipo);
    const formaPgto = trim(req.query.formaPgto);
    const status = trim(req.query.status);   // filtra por um estatus_cod específico (opcional)
    const busca = trim(req.query.busca).toUpperCase();

    const params = { inicio, fim };
    const conds = [];
    if (tipo) { conds.push(`AND RTRIM(sc5.C5_ZTIPO) = @tipo`); params.tipo = tipo; }
    if (formaPgto) { conds.push(`AND RTRIM(sc5.C5_FORMAPG) = @forma`); params.forma = formaPgto; }
    if (status) { conds.push(`AND pe_agg.maxEstatus = @status`); params.status = N(status); }
    if (busca) { conds.push(`AND (sc5.C5_NUM LIKE '%' + @busca + '%' OR UPPER(sa1.A1_NOME) LIKE '%' + @busca + '%')`); params.busca = busca; }

    // Agrega pedidos_estatus por pedido: status mais avançado + última data de liberação.
    const sql = `
      SELECT
        RTRIM(sc5.C5_NUM)     AS pedido,
        RTRIM(sc5.C5_ZTIPO)   AS tipoCod,
        RTRIM(x5.X5_DESCRI)   AS tipoNome,
        sc5.C5_EMISSAO        AS emissao,
        pe_agg.dataLib        AS dataLiberacao,
        pe_agg.maxEstatus     AS statusCod,
        RTRIM(sc5.C5_FORMAPG) AS formaPgtoCod,
        RTRIM(cnd.E4_DESCRI)  AS condPagNome,
        RTRIM(sc5.C5_CLIENTE) AS clienteCod,
        RTRIM(sc5.C5_LOJACLI) AS clienteLoja,
        RTRIM(sa1.A1_NOME)    AS clienteNome,
        RTRIM(sa1.A1_CGC)     AS clienteCgc,
        RTRIM(sa1.A1_EST)     AS clienteEstado,
        RTRIM(sc5.C5_VEND1)   AS vendCod,
        RTRIM(sa3.A3_NOME)    AS vendNome,
        CAST(ISNULL(tp6.total,0)  AS NUMERIC(14,2)) AS totalPedido,
        CAST(ISNULL(tp62.total,0) AS NUMERIC(14,2)) AS valorSaldo,
        CAST(ISNULL(pra.saldo,0)  AS NUMERIC(14,2)) AS pago,
        CAST(ISNULL(prf.saldo,0)  AS NUMERIC(14,2)) AS pagar,
        CAST(ISNULL(tp6.total,0) - ISNULL(pra.saldo,0) - ISNULL(prf.saldo,0) AS NUMERIC(14,2)) AS difFinan
      FROM SC5010 sc5 WITH (NOLOCK)
      JOIN (
        SELECT pe.c6_filial, pe.c6_num,
               MAX(pe.estatus_cod) AS maxEstatus,
               MAX(RTRIM(pe.c9_datalib)) AS dataLib,
               MAX(CASE WHEN pe.estatus_cod IN (30,40,50,60,99) THEN 1 ELSE 0 END) AS temLiberado
          FROM pedidos_estatus pe
         GROUP BY pe.c6_filial, pe.c6_num
      ) pe_agg ON pe_agg.c6_filial = sc5.C5_FILIAL AND pe_agg.c6_num = sc5.C5_NUM
      LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = sc5.C5_CLIENTE AND sa1.A1_LOJA = sc5.C5_LOJACLI AND sa1.D_E_L_E_T_ <> '*'
      LEFT JOIN SA3010 sa3 WITH (NOLOCK) ON sa3.A3_COD = sc5.C5_VEND1 AND sa3.D_E_L_E_T_ <> '*'
      LEFT JOIN SE4010 cnd WITH (NOLOCK) ON cnd.E4_CODIGO = sc5.C5_CONDPAG AND cnd.D_E_L_E_T_ <> '*'
      LEFT JOIN SX5010 x5 WITH (NOLOCK) ON RTRIM(x5.X5_TABELA) = 'Z1' AND RTRIM(x5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND x5.D_E_L_E_T_ <> '*'
      LEFT JOIN total_pedido_sc6       tp6  WITH (NOLOCK) ON tp6.c6_num  = sc5.C5_NUM
      LEFT JOIN total_pedido_sc6_saldo tp62 WITH (NOLOCK) ON tp62.c6_num = sc5.C5_NUM
      LEFT JOIN pedidos_ra pra WITH (NOLOCK) ON pra.pedido = sc5.C5_NUM
      LEFT JOIN pedidos_rf prf WITH (NOLOCK) ON prf.pedido = sc5.C5_NUM
      WHERE sc5.C5_FILIAL = '01' AND sc5.D_E_L_E_T_ <> '*'
        AND pe_agg.temLiberado = 1
        AND pe_agg.dataLib BETWEEN @inicio AND @fim
        ${conds.join(' ')}
      ORDER BY pe_agg.dataLib DESC, sc5.C5_NUM`;

    try {
      const rows = await Protheus.connectAndQuery(sql, params);

      const pedidos = rows.map(r => {
        const statusCod = N(r.statusCod);
        return {
          pedido: trim(r.pedido),
          tipoCod: trim(r.tipoCod),
          tipoNome: trim(r.tipoNome) || trim(r.tipoCod) || '(sem tipo)',
          emissao: trim(r.emissao),
          dataLiberacao: trim(r.dataLiberacao),
          statusCod,
          statusLabel: STATUS_LABEL[statusCod] || `Status ${statusCod}`,
          faturado: statusCod === 99,
          formaPgtoCod: trim(r.formaPgtoCod),
          formaPgtoNome: descreverFormaPgto(trim(r.formaPgtoCod)),
          condPagNome: trim(r.condPagNome),
          clienteCod: trim(r.clienteCod),
          clienteLoja: trim(r.clienteLoja),
          clienteNome: trim(r.clienteNome),
          clienteCgc: trim(r.clienteCgc),
          clienteEstado: trim(r.clienteEstado),
          vendCod: trim(r.vendCod),
          vendNome: trim(r.vendNome),
          totalPedido: N(r.totalPedido),
          valorSaldo: N(r.valorSaldo),
          pago: N(r.pago),
          pagar: N(r.pagar),
          difFinan: N(r.difFinan)
        };
      });

      // Filtros disponíveis + KPIs
      const tiposMap = new Map(), formasMap = new Map(), statusMap = new Map();
      pedidos.forEach(p => {
        if (p.tipoCod) tiposMap.set(p.tipoCod, p.tipoNome);
        if (p.formaPgtoCod) formasMap.set(p.formaPgtoCod, descreverFormaPgto(p.formaPgtoCod));
        statusMap.set(p.statusCod, (statusMap.get(p.statusCod) || 0) + 1);
      });

      return res.json({
        periodo: { inicio, fim },
        filtros: { tipo, formaPgto, status, busca },
        qtdPedidos: pedidos.length,
        totalGeral: pedidos.reduce((s, p) => s + p.totalPedido, 0),
        qtdFaturados: pedidos.filter(p => p.faturado).length,
        qtdLiberadosNaoFaturados: pedidos.filter(p => !p.faturado).length,
        tiposDisponiveis: [...tiposMap.entries()].map(([cod, nome]) => ({ cod, nome })).sort((a, b) => a.nome.localeCompare(b.nome)),
        formasDisponiveis: [...formasMap.entries()].map(([cod, nome]) => ({ cod, nome })).sort((a, b) => a.nome.localeCompare(b.nome)),
        statusDisponiveis: [...statusMap.entries()].map(([cod, qtd]) => ({ cod, nome: STATUS_LABEL[cod] || `Status ${cod}`, qtd })).sort((a, b) => a.cod - b.cod),
        pedidos,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro financeiro/liberacao-historico:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// GET /financeiro/liberacao
//
// Lista os pedidos "Aguardando liberação do Financeiro" (pedidos_estatus.
// estatus_cod = 20), 1 linha por pedido, com o resumo financeiro de cada um
// (total, pago, a pagar, diferença, rec. mín. faturamento) + as flags de apoio
// "verificar financeiro" / "não liberar (restrição de pagto)". Junta as
// anotações (ações/observações) cadastradas pela operadora em
// tab_lib_financeira_anotacao.
//
// Substitui o processo manual: planilha de carteira -> tabela dinâmica filtrada
// por status. A liberação efetiva continua no Protheus (Onda 2 fará write-back).
//
// Filtros (query): tipo (C5_ZTIPO), formaPgto (C5_FORMAPG), busca (pedido ou
// nome do cliente). Devolve tambem listas distintas pra popular os filtros.
//
// Permissão 8006.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006]);

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

// E1/C5 forma de pagamento — mesmo mapeamento usado na Cobrança.
const FORMAS_PGTO = {
  '1': 'Cheque', '2': 'Dinheiro', '3': 'Cartão', '4': 'Boleto Bancário',
  '5': 'Não informado', '6': 'Financiamento', '7': 'Cartão BNDS',
  '8': 'Bonificação', '9': 'Consignado', 'B': 'Antecipação Parcelada',
  'A': 'Futuro Garantido', '': 'Não informado'
};
const descreverFormaPgto = (cod) => FORMAS_PGTO[cod] || `Forma ${cod}`;

const ESTATUS_FINANCEIRO = 20;  // pedidos_estatus.estatus_cod

module.exports = (app) => ({
  verb: 'get',
  route: '/liberacao',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const tipo      = trim(req.query.tipo);
    const formaPgto = trim(req.query.formaPgto);
    const busca     = trim(req.query.busca).toUpperCase();

    const params = { est: ESTATUS_FINANCEIRO };
    const conds = [];
    if (tipo)      { conds.push(`AND RTRIM(sc5.C5_ZTIPO) = @tipo`);    params.tipo = tipo; }
    if (formaPgto) { conds.push(`AND RTRIM(sc5.C5_FORMAPG) = @forma`); params.forma = formaPgto; }
    if (busca)     {
      conds.push(`AND (sc5.C5_NUM LIKE '%' + @busca + '%' OR UPPER(sa1.A1_NOME) LIKE '%' + @busca + '%')`);
      params.busca = busca;
    }

    const sql = `
      SELECT
        RTRIM(sc5.C5_NUM)       AS pedido,
        RTRIM(sc5.C5_ZTIPO)     AS tipoCod,
        RTRIM(x5.X5_DESCRI)     AS tipoNome,
        sc5.C5_EMISSAO          AS emissao,
        RTRIM(sc5.C5_FORMAPG)   AS formaPgtoCod,
        RTRIM(sc5.C5_CONDPAG)   AS condPagCod,
        RTRIM(cnd.E4_DESCRI)    AS condPagNome,
        RTRIM(sc5.C5_CLIENTE)   AS clienteCod,
        RTRIM(sc5.C5_LOJACLI)   AS clienteLoja,
        RTRIM(sa1.A1_NOME)      AS clienteNome,
        RTRIM(sa1.A1_CGC)       AS clienteCgc,
        RTRIM(sa1.A1_EST)       AS clienteEstado,
        RTRIM(sc5.C5_VEND1)     AS vendCod,
        RTRIM(sa3.A3_NOME)      AS vendNome,
        RTRIM(sc5.C5_ZEXPRES)   AS expresso,
        RTRIM(sc5.C5_ZFATPAR)   AS fatParcial,
        RTRIM(sc5.C5_ZGERFIN)   AS geraTp,
        CAST(ISNULL(tp6.total,0)  AS NUMERIC(14,2)) AS totalPedido,
        CAST(ISNULL(tp62.total,0) AS NUMERIC(14,2)) AS valorSaldo,
        CAST(ISNULL(pra.saldo,0)  AS NUMERIC(14,2)) AS pago,
        CAST(ISNULL(prf.saldo,0)  AS NUMERIC(14,2)) AS pagar,
        CAST(ISNULL(pra.saldo,0) + ISNULL(prf.saldo,0) AS NUMERIC(14,2)) AS totalFinan,
        CAST(ISNULL(tp6.total,0) - ISNULL(pra.saldo,0) - ISNULL(prf.saldo,0) AS NUMERIC(14,2)) AS difFinan,
        CAST(ISNULL(sc5.C5_VLMINFT,0) AS NUMERIC(14,2)) AS recMinFat
      FROM SC5010 sc5 WITH (NOLOCK)
      LEFT JOIN SA1010 sa1 WITH (NOLOCK)
        ON sa1.A1_COD = sc5.C5_CLIENTE AND sa1.A1_LOJA = sc5.C5_LOJACLI AND sa1.D_E_L_E_T_ <> '*'
      LEFT JOIN SA3010 sa3 WITH (NOLOCK)
        ON sa3.A3_COD = sc5.C5_VEND1 AND sa3.D_E_L_E_T_ <> '*'
      LEFT JOIN SE4010 cnd WITH (NOLOCK)
        ON cnd.E4_CODIGO = sc5.C5_CONDPAG AND cnd.D_E_L_E_T_ <> '*'
      LEFT JOIN SX5010 x5 WITH (NOLOCK)
        ON RTRIM(x5.X5_TABELA) = 'Z1' AND RTRIM(x5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND x5.D_E_L_E_T_ <> '*'
      LEFT JOIN total_pedido_sc6       tp6  WITH (NOLOCK) ON tp6.c6_num  = sc5.C5_NUM
      LEFT JOIN total_pedido_sc6_saldo tp62 WITH (NOLOCK) ON tp62.c6_num = sc5.C5_NUM
      LEFT JOIN pedidos_ra pra WITH (NOLOCK) ON pra.pedido = sc5.C5_NUM
      LEFT JOIN pedidos_rf prf WITH (NOLOCK) ON prf.pedido = sc5.C5_NUM
      WHERE sc5.C5_FILIAL = '01'
        AND sc5.D_E_L_E_T_ <> '*'
        AND EXISTS (
          SELECT 1 FROM pedidos_estatus pe
           WHERE pe.c6_filial = sc5.C5_FILIAL
             AND pe.c6_num    = sc5.C5_NUM
             AND pe.estatus_cod = @est
        )
        ${conds.join(' ')}
      ORDER BY sc5.C5_EMISSAO, sc5.C5_NUM`;

    try {
      const rows = await Protheus.connectAndQuery(sql, params);

      // Anotações da Intranet (ações/observações), indexadas por pedido.
      const anotMap = new Map();
      try {
        const anot = await Pg.connectAndQuery(
          `SELECT pedido, acoes, observacoes, atualizado_por_nome, atualizado_em
             FROM tab_lib_financeira_anotacao WHERE filial = '01'`, {}
        );
        anot.forEach(a => anotMap.set(trim(a.pedido), {
          acoes: a.acoes || '',
          observacoes: a.observacoes || '',
          atualizadoPorNome: trim(a.atualizado_por_nome),
          atualizadoEm: a.atualizado_em
        }));
      } catch (e) {
        console.warn('liberacao-list: falha ao carregar anotações — seguindo sem.', e.message);
      }

      const pedidos = rows.map(r => {
        const totalPedido = N(r.totalPedido);
        const pago   = N(r.pago);
        const pagar  = N(r.pagar);
        const difFinan = N(r.difFinan);
        const recMinFat = N(r.recMinFat);
        const geraTp = trim(r.geraTp) === 'S';

        // Flags de apoio (mesma lógica do relatório PHP da carteira):
        //  - verificarFinanceiro: gera TP, tem diferença financeira e está num
        //    estatus > inicial (aqui sempre 20). Indica divergência a conferir.
        //  - restricaoPagto: tem recebimento mínimo de faturamento exigido e
        //    ainda não foi atingido (recMinFat > pago) -> NÃO liberar.
        const verificarFinanceiro = geraTp && Math.round(difFinan) !== 0;
        const restricaoPagto = recMinFat > 0 && recMinFat > pago;

        const anot = anotMap.get(trim(r.pedido)) || null;

        return {
          pedido: trim(r.pedido),
          tipoCod: trim(r.tipoCod),
          tipoNome: trim(r.tipoNome) || trim(r.tipoCod) || '(sem tipo)',
          emissao: trim(r.emissao),
          formaPgtoCod: trim(r.formaPgtoCod),
          formaPgtoNome: descreverFormaPgto(trim(r.formaPgtoCod)),
          condPagCod: trim(r.condPagCod),
          condPagNome: trim(r.condPagNome),
          clienteCod: trim(r.clienteCod),
          clienteLoja: trim(r.clienteLoja),
          clienteNome: trim(r.clienteNome),
          clienteCgc: trim(r.clienteCgc),
          clienteEstado: trim(r.clienteEstado),
          vendCod: trim(r.vendCod),
          vendNome: trim(r.vendNome),
          expresso: trim(r.expresso),
          fatParcial: trim(r.fatParcial),
          geraTp,
          totalPedido,
          valorSaldo: N(r.valorSaldo),
          pago,
          pagar,
          totalFinan: N(r.totalFinan),
          difFinan,
          recMinFat,
          verificarFinanceiro,
          restricaoPagto,
          // anotações da operadora
          acoes: anot ? anot.acoes : '',
          observacoes: anot ? anot.observacoes : '',
          anotadoPor: anot ? anot.atualizadoPorNome : '',
          anotadoEm: anot ? anot.atualizadoEm : null
        };
      });

      // Listas distintas pra popular os filtros (sobre o universo carregado).
      const tiposMap = new Map();
      const formasMap = new Map();
      pedidos.forEach(p => {
        if (p.tipoCod) tiposMap.set(p.tipoCod, p.tipoNome);
        if (p.formaPgtoCod) formasMap.set(p.formaPgtoCod, (formasMap.get(p.formaPgtoCod) || 0) + 1);
      });
      const tiposDisponiveis = [...tiposMap.entries()]
        .map(([cod, nome]) => ({ cod, nome }))
        .sort((a, b) => a.nome.localeCompare(b.nome));
      const formasDisponiveis = [...formasMap.entries()]
        .map(([cod, qtd]) => ({ cod, nome: descreverFormaPgto(cod), qtd }))
        .sort((a, b) => a.nome.localeCompare(b.nome));

      // KPIs
      const totalGeral = pedidos.reduce((s, p) => s + p.totalPedido, 0);
      const qtdVerificar = pedidos.filter(p => p.verificarFinanceiro).length;
      const qtdRestricao = pedidos.filter(p => p.restricaoPagto).length;

      return res.json({
        filtros: { tipo, formaPgto, busca },
        qtdPedidos: pedidos.length,
        totalGeral,
        qtdVerificar,
        qtdRestricao,
        tiposDisponiveis,
        formasDisponiveis,
        pedidos,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro financeiro/liberacao:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

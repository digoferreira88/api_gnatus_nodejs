// GET /fiscal/fila-faturamento?tipo=&formaPgto=&busca=
// Fila de Faturamento — pedidos liberados em TODAS as etapas anteriores e
// AGUARDANDO FATURAMENTO (pedidos_estatus.estatus_cod = 60), 1 linha por pedido,
// ignorando itens já totalmente faturados. Perm 16001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

const FORMAS_PGTO = {
  '1': 'Cheque', '2': 'Dinheiro', '3': 'Cartão', '4': 'Boleto Bancário', '5': 'Não informado',
  '6': 'Financiamento', '7': 'Cartão BNDS', '8': 'Bonificação', '9': 'Consignado',
  'B': 'Antecipação Parcelada', 'A': 'Futuro Garantido', '': 'Não informado'
};
const formaLabel = (c) => FORMAS_PGTO[trim(c)] || `Forma ${trim(c)}`;
const ESTATUS_FATURAMENTO = 60;

module.exports = (app) => ({
  verb: 'get',
  route: '/fila-faturamento',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const tipo = trim(req.query.tipo), formaPgto = trim(req.query.formaPgto), busca = trim(req.query.busca).toUpperCase();
    const params = { est: ESTATUS_FATURAMENTO };
    const conds = [];
    if (tipo) { conds.push(`AND RTRIM(sc5.C5_ZTIPO)=@tipo`); params.tipo = tipo; }
    if (formaPgto) { conds.push(`AND RTRIM(sc5.C5_FORMAPG)=@forma`); params.forma = formaPgto; }
    if (busca) { conds.push(`AND (sc5.C5_NUM LIKE '%'+@busca+'%' OR UPPER(sa1.A1_NOME) LIKE '%'+@busca+'%')`); params.busca = busca; }

    const sql = `
      SELECT RTRIM(sc5.C5_NUM) pedido, RTRIM(sc5.C5_ZTIPO) tipoCod, RTRIM(x5.X5_DESCRI) tipoNome,
             sc5.C5_EMISSAO emissao, RTRIM(sc5.C5_FORMAPG) formaPgtoCod,
             RTRIM(sc5.C5_CLIENTE) clienteCod, RTRIM(sc5.C5_LOJACLI) clienteLoja,
             RTRIM(sa1.A1_NOME) clienteNome, RTRIM(sa1.A1_CGC) clienteCgc, RTRIM(sa1.A1_EST) uf,
             RTRIM(sc5.C5_VEND1) vendCod, RTRIM(sa3.A3_NOME) vendNome,
             RTRIM(sc5.C5_ZEXPRES) expresso,
             CAST(ISNULL(tp6.total,0) AS NUMERIC(14,2)) totalPedido,
             (SELECT MAX(RTRIM(pe2.c9_datalib)) FROM pedidos_estatus pe2
               WHERE pe2.c6_filial=sc5.C5_FILIAL AND pe2.c6_num=sc5.C5_NUM AND pe2.estatus_cod=@est) dataLiberado
        FROM SC5010 sc5 WITH (NOLOCK)
        LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD=sc5.C5_CLIENTE AND sa1.A1_LOJA=sc5.C5_LOJACLI AND sa1.D_E_L_E_T_<>'*'
        LEFT JOIN SA3010 sa3 WITH (NOLOCK) ON sa3.A3_COD=sc5.C5_VEND1 AND sa3.D_E_L_E_T_<>'*'
        LEFT JOIN SX5010 x5 WITH (NOLOCK) ON RTRIM(x5.X5_TABELA)='Z1' AND RTRIM(x5.X5_CHAVE)=RTRIM(sc5.C5_ZTIPO) AND x5.D_E_L_E_T_<>'*'
        LEFT JOIN total_pedido_sc6 tp6 WITH (NOLOCK) ON tp6.c6_num=sc5.C5_NUM
       WHERE sc5.C5_FILIAL='01' AND sc5.D_E_L_E_T_<>'*'
         AND EXISTS (
           SELECT 1 FROM pedidos_estatus pe
            JOIN SC6010 c6f WITH (NOLOCK) ON c6f.C6_FILIAL=pe.c6_filial AND c6f.C6_NUM=pe.c6_num AND c6f.C6_ITEM=pe.c6_item AND c6f.D_E_L_E_T_<>'*'
            WHERE pe.c6_filial=sc5.C5_FILIAL AND pe.c6_num=sc5.C5_NUM AND pe.estatus_cod=@est
              AND c6f.C6_QTDENT < c6f.C6_QTDVEN )
         ${conds.join(' ')}
       ORDER BY sc5.C5_EMISSAO, sc5.C5_NUM`;

    try {
      const rows = await Protheus.connectAndQuery(sql, params);
      const pedidos = rows.map(r => ({
        pedido: trim(r.pedido), tipoCod: trim(r.tipoCod), tipoNome: trim(r.tipoNome) || trim(r.tipoCod) || '(sem tipo)',
        emissao: trim(r.emissao), dataLiberado: trim(r.dataLiberado),
        formaPgtoCod: trim(r.formaPgtoCod), formaPgtoNome: formaLabel(r.formaPgtoCod),
        clienteCod: trim(r.clienteCod), clienteLoja: trim(r.clienteLoja), clienteNome: trim(r.clienteNome),
        clienteCgc: trim(r.clienteCgc), uf: trim(r.uf), vendCod: trim(r.vendCod), vendNome: trim(r.vendNome),
        expresso: trim(r.expresso) === 'S', totalPedido: N(r.totalPedido)
      }));
      const tiposMap = new Map(), formasMap = new Map();
      pedidos.forEach(p => { if (p.tipoCod) tiposMap.set(p.tipoCod, p.tipoNome); if (p.formaPgtoCod) formasMap.set(p.formaPgtoCod, (formasMap.get(p.formaPgtoCod) || 0) + 1); });
      return res.json({
        filtros: { tipo, formaPgto, busca },
        qtdPedidos: pedidos.length,
        totalGeral: +pedidos.reduce((s, p) => s + p.totalPedido, 0).toFixed(2),
        tiposDisponiveis: [...tiposMap.entries()].map(([cod, nome]) => ({ cod, nome })).sort((a, b) => a.nome.localeCompare(b.nome)),
        formasDisponiveis: [...formasMap.entries()].map(([cod, qtd]) => ({ cod, nome: formaLabel(cod), qtd })).sort((a, b) => a.nome.localeCompare(b.nome)),
        pedidos,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro fiscal/fila-faturamento:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

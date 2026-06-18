// GET /fiscal/pedido/:pedido
// Resumo de um pedido para a Fila de Faturamento (Painel Fiscal):
//   - cabeçalho: cliente, vendedor, tipo (BU), emissão, condição pgto, total
//   - itens:     linhas do SC6 (produto, qtd vendida/entregue/saldo, preço, total, TES, CFOP, armazém)
//   - observações: campos de observação do SC5 preenchidos
// Somente leitura. Perm 16001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

const CAMPOS_OBS = [
  { campo: 'mennota', label: 'Mensagem da Nota' },
  { campo: 'coment', label: 'Comentário' },
  { campo: 'obsfisc', label: 'Obs. Fiscal' },
  { campo: 'obsplan', label: 'Obs. Planejamento' },
  { campo: 'menpad', label: 'Mensagem Padrão' }
];

module.exports = (app) => ({
  verb: 'get',
  route: '/pedido/:pedido',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const pedido = trim(req.params.pedido);
    if (!pedido || pedido.length > 10) return res.status(400).json({ message: 'pedido inválido.' });

    try {
      // 1) Cabeçalho
      const cabRows = await Protheus.connectAndQuery(`
        SELECT RTRIM(sc5.C5_NUM) pedido, sc5.C5_EMISSAO emissao,
               RTRIM(sc5.C5_ZTIPO) tipoCod, RTRIM(x5.X5_DESCRI) tipoNome,
               RTRIM(sc5.C5_CLIENTE) clienteCod, RTRIM(sc5.C5_LOJACLI) clienteLoja,
               RTRIM(sa1.A1_NOME) clienteNome, RTRIM(sa1.A1_CGC) clienteCgc, RTRIM(sa1.A1_EST) uf,
               RTRIM(sc5.C5_VEND1) vendCod, RTRIM(sa3.A3_NOME) vendNome,
               RTRIM(sc5.C5_CONDPAG) condPag,
               RTRIM(sc5.C5_MENNOTA) mennota, RTRIM(sc5.C5_COMENT) coment,
               RTRIM(sc5.C5_OBSFISC) obsfisc, RTRIM(sc5.C5_OBSPLAN) obsplan, RTRIM(sc5.C5_MENPAD) menpad,
               CAST(ISNULL(tp6.total,0) AS NUMERIC(14,2)) total
          FROM SC5010 sc5 WITH (NOLOCK)
          LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD=sc5.C5_CLIENTE AND sa1.A1_LOJA=sc5.C5_LOJACLI AND sa1.D_E_L_E_T_<>'*'
          LEFT JOIN SA3010 sa3 WITH (NOLOCK) ON sa3.A3_COD=sc5.C5_VEND1 AND sa3.D_E_L_E_T_<>'*'
          LEFT JOIN SX5010 x5 WITH (NOLOCK) ON RTRIM(x5.X5_TABELA)='Z1' AND RTRIM(x5.X5_CHAVE)=RTRIM(sc5.C5_ZTIPO) AND x5.D_E_L_E_T_<>'*'
          LEFT JOIN total_pedido_sc6 tp6 WITH (NOLOCK) ON tp6.c6_num=sc5.C5_NUM
         WHERE sc5.C5_FILIAL='01' AND sc5.C5_NUM=@p AND sc5.D_E_L_E_T_<>'*'`,
        { p: pedido });
      if (!cabRows.length) return res.status(404).json({ message: `Pedido ${pedido} não encontrado.` });
      const c = cabRows[0];

      const observacoes = CAMPOS_OBS
        .map(o => ({ label: o.label, valor: trim(c[o.campo]) }))
        .filter(o => o.valor);

      // 2) Itens
      const itensRows = await Protheus.connectAndQuery(`
        SELECT sc6.C6_ITEM item, RTRIM(sc6.C6_PRODUTO) produto, RTRIM(sc6.C6_DESCRI) descricao,
               RTRIM(sc6.C6_UM) um, sc6.C6_QTDVEN qtdVen, sc6.C6_QTDENT qtdEnt,
               (sc6.C6_QTDVEN - sc6.C6_QTDENT) saldo, sc6.C6_PRCVEN prcVen, sc6.C6_VALOR valor,
               RTRIM(sc6.C6_LOCAL) local, RTRIM(sc6.C6_TES) tes, RTRIM(sc6.C6_CF) cfop, RTRIM(sc6.C6_BLQ) blq
          FROM SC6010 sc6 WITH (NOLOCK)
         WHERE sc6.C6_FILIAL='01' AND sc6.C6_NUM=@p AND sc6.D_E_L_E_T_<>'*'
         ORDER BY sc6.C6_ITEM`, { p: pedido });
      const itens = itensRows.map(r => ({
        item: trim(r.item), produto: trim(r.produto), descricao: trim(r.descricao), um: trim(r.um),
        qtdVen: N(r.qtdVen), qtdEnt: N(r.qtdEnt), saldo: N(r.saldo), prcVen: N(r.prcVen), valor: N(r.valor),
        local: trim(r.local), tes: trim(r.tes), cfop: trim(r.cfop),
        bloqueado: trim(r.blq) !== '' && trim(r.blq) !== ' '
      }));

      return res.json({
        pedido,
        cabecalho: {
          emissao: trim(c.emissao), tipoCod: trim(c.tipoCod), tipoNome: trim(c.tipoNome) || trim(c.tipoCod),
          clienteCod: trim(c.clienteCod), clienteLoja: trim(c.clienteLoja), clienteNome: trim(c.clienteNome),
          clienteCgc: trim(c.clienteCgc), uf: trim(c.uf),
          vendCod: trim(c.vendCod), vendNome: trim(c.vendNome),
          condPag: trim(c.condPag), total: N(c.total)
        },
        observacoes,
        itens,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro fiscal/pedido-resumo:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

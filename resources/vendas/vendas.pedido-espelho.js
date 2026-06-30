// GET /vendas/pedido/:pedido — "espelho" completo de um pedido de venda:
//   cabeçalho (cliente, vendedor, condição pgto, frete, transportadora, faturamento),
//   observações, itens (qtd vendida/entregue/saldo, preço, total, faturado) e
//   um resumo do andamento. Somente leitura. Perm 2006.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([2007, 0]);
const Estatus = require('../../services/vendasEstatus');
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

const TPFRETE = {
  C: 'CIF — por conta do emitente', F: 'FOB — por conta do destinatário',
  T: 'Por conta de terceiros', R: 'Por conta do remetente',
  D: 'Por conta do destinatário', S: 'Sem frete', N: 'Sem frete'
};

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
      const cabRows = await Protheus.connectAndQuery(`
        SELECT RTRIM(sc5.C5_NUM) pedido, sc5.C5_EMISSAO emissao,
               RTRIM(sc5.C5_ZTIPO) tipoCod, RTRIM(x5.X5_DESCRI) tipoNome,
               RTRIM(sc5.C5_CLIENTE) clienteCod, RTRIM(sc5.C5_LOJACLI) clienteLoja,
               RTRIM(sa1.A1_NOME) clienteNome, RTRIM(sa1.A1_CGC) clienteCgc, RTRIM(sa1.A1_EST) uf,
               RTRIM(sa1.A1_MUN) municipio, RTRIM(sa1.A1_END) endereco, RTRIM(sa1.A1_BAIRRO) bairro, RTRIM(sa1.A1_CEP) cep,
               RTRIM(sc5.C5_VEND1) vendCod, RTRIM(sa3.A3_NOME) vendNome,
               RTRIM(sc5.C5_CONDPAG) condPagCod,
               (SELECT TOP 1 RTRIM(E4_DESCRI) FROM SE4010 WITH (NOLOCK) WHERE E4_CODIGO=sc5.C5_CONDPAG AND D_E_L_E_T_<>'*') condPagDesc,
               RTRIM(sc5.C5_TPFRETE) tpFrete, RTRIM(sc5.C5_TRANSP) transpCod,
               (SELECT TOP 1 RTRIM(A4_NOME) FROM SA4010 WITH (NOLOCK) WHERE A4_COD=sc5.C5_TRANSP AND D_E_L_E_T_<>'*') transpNome,
               sc5.C5_FRETE frete, sc5.C5_DESPESA despesa, sc5.C5_SEGURO seguro,
               RTRIM(sc5.C5_NOTA) nota, RTRIM(sc5.C5_SERIE) serie,
               RTRIM(sc5.C5_LIBEROK) liberok, RTRIM(sc5.C5_BLQ) blq,
               RTRIM(sc5.C5_MENNOTA) mennota, RTRIM(sc5.C5_COMENT) coment,
               RTRIM(sc5.C5_OBSFISC) obsfisc, RTRIM(sc5.C5_OBSPLAN) obsplan, RTRIM(sc5.C5_MENPAD) menpad,
               ISNULL(it.total, 0) total
          FROM SC5010 sc5 WITH (NOLOCK)
          LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD=sc5.C5_CLIENTE AND sa1.A1_LOJA=sc5.C5_LOJACLI AND sa1.D_E_L_E_T_<>'*'
          LEFT JOIN SA3010 sa3 WITH (NOLOCK) ON sa3.A3_COD=sc5.C5_VEND1 AND sa3.D_E_L_E_T_<>'*'
          LEFT JOIN SX5010 x5 WITH (NOLOCK) ON RTRIM(x5.X5_TABELA)='Z1' AND RTRIM(x5.X5_CHAVE)=RTRIM(sc5.C5_ZTIPO) AND x5.D_E_L_E_T_<>'*'
          LEFT JOIN (SELECT C6_FILIAL, C6_NUM, SUM(C6_VALOR) total FROM SC6010 WITH (NOLOCK) WHERE D_E_L_E_T_<>'*' GROUP BY C6_FILIAL, C6_NUM) it
            ON it.C6_FILIAL=sc5.C5_FILIAL AND it.C6_NUM=sc5.C5_NUM
         WHERE sc5.C5_FILIAL='01' AND sc5.C5_NUM=@p AND sc5.D_E_L_E_T_<>'*'`,
        { p: pedido });
      if (!cabRows.length) return res.status(404).json({ message: `Pedido ${pedido} não encontrado.` });
      const c = cabRows[0];

      const observacoes = CAMPOS_OBS
        .map(o => ({ label: o.label, valor: trim(c[o.campo]) }))
        .filter(o => o.valor);

      const itensRows = await Protheus.connectAndQuery(`
        SELECT sc6.C6_ITEM item, RTRIM(sc6.C6_PRODUTO) produto, RTRIM(sc6.C6_DESCRI) descricao, RTRIM(sc6.C6_UM) um,
               sc6.C6_QTDVEN qtdVen, sc6.C6_QTDENT qtdEnt, (sc6.C6_QTDVEN - sc6.C6_QTDENT) saldo,
               sc6.C6_PRCVEN prcVen, sc6.C6_VALOR valor, RTRIM(sc6.C6_LOCAL) local,
               RTRIM(sc6.C6_TES) tes, RTRIM(sc6.C6_CF) cfop, RTRIM(sc6.C6_BLQ) blq,
               sc6.C6_ENTREG entrega, RTRIM(sc6.C6_NOTA) nota, RTRIM(sc6.C6_SERIE) serieNf,
               pe.cod estCod
          FROM SC6010 sc6 WITH (NOLOCK)
          LEFT JOIN (SELECT c6_filial, c6_num, c6_item, c6_produto, MIN(estatus_cod) cod
                       FROM pedidos_estatus WHERE c6_num=@p GROUP BY c6_filial, c6_num, c6_item, c6_produto) pe
            ON pe.c6_filial=sc6.C6_FILIAL AND pe.c6_num=sc6.C6_NUM AND pe.c6_item=sc6.C6_ITEM AND pe.c6_produto=sc6.C6_PRODUTO
         WHERE sc6.C6_FILIAL='01' AND sc6.C6_NUM=@p AND sc6.D_E_L_E_T_<>'*'
         ORDER BY sc6.C6_ITEM`, { p: pedido });

      const itens = itensRows.map(r => ({
        item: trim(r.item), produto: trim(r.produto), descricao: trim(r.descricao), um: trim(r.um),
        qtdVen: N(r.qtdVen), qtdEnt: N(r.qtdEnt), saldo: N(r.saldo), prcVen: N(r.prcVen), valor: N(r.valor),
        local: trim(r.local), tes: trim(r.tes), cfop: trim(r.cfop),
        entrega: trim(r.entrega), nota: trim(r.nota), serieNf: trim(r.serieNf),
        faturado: trim(r.nota) !== '',
        bloqueado: trim(r.blq) !== '' && trim(r.blq) !== ' ',
        situacao: Estatus.info(r.estCod)
      }));

      // Status do PEDIDO = estágio do gargalo (menor estatus_cod entre os itens).
      const codsItens = itens.map(i => i.situacao.cod).filter(v => v != null);
      const statusPed = Estatus.info(codsItens.length ? Math.min(...codsItens) : null);

      const andamento = {
        totalItens: itens.length,
        itensFaturados: itens.filter(i => i.faturado).length,
        itensEntregues: itens.filter(i => i.saldo <= 0).length,
        valorPedido: N(c.total),
        valorFaturado: itens.filter(i => i.faturado).reduce((s, i) => s + i.valor, 0)
      };

      return res.json({
        pedido,
        status: statusPed,
        cabecalho: {
          emissao: trim(c.emissao), tipoCod: trim(c.tipoCod), tipoNome: trim(c.tipoNome) || trim(c.tipoCod),
          clienteCod: trim(c.clienteCod), clienteLoja: trim(c.clienteLoja), clienteNome: trim(c.clienteNome),
          clienteCgc: trim(c.clienteCgc), uf: trim(c.uf), municipio: trim(c.municipio),
          endereco: trim(c.endereco), bairro: trim(c.bairro), cep: trim(c.cep),
          vendCod: trim(c.vendCod), vendNome: trim(c.vendNome),
          condPagCod: trim(c.condPagCod), condPagDesc: trim(c.condPagDesc),
          tpFrete: trim(c.tpFrete), tpFreteLabel: TPFRETE[trim(c.tpFrete)] || trim(c.tpFrete) || '—',
          transpCod: trim(c.transpCod), transpNome: trim(c.transpNome),
          frete: N(c.frete), despesa: N(c.despesa), seguro: N(c.seguro),
          nota: trim(c.nota), serie: trim(c.serie),
          total: N(c.total)
        },
        observacoes,
        itens,
        andamento,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro vendas/pedido-espelho:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

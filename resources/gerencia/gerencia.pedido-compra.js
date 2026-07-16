// GET /gerencia/pedido-compra/:num
// Espelho do pedido de compra COMPLETO (todos os itens, todas as contas/CCs) —
// aberto ao clicar no nº do PC no 4º nível do DRE por Centro de Custo. Mostra
// cabeçalho (fornecedor, comprador, condição, moeda), itens (com CC/conta/NF/
// valores, recebido, entrega) e totais. Valores em R$ convertem moeda
// estrangeira (C7_TXMOEDA), como o restante da tela. Perm 10001 (DRE).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10001]);
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const emReais = (total, moeda, taxa) => (N(moeda) !== 1 && N(taxa) > 0) ? N(total) * N(taxa) : N(total);

module.exports = (app) => ({
  verb: 'get',
  route: '/pedido-compra/:num',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const num = trim(req.params.num);
    if (!num) return res.status(400).json({ message: 'pedido inválido.' });

    try {
      // 1) Itens do pedido + fornecedor + condição
      let itens;
      try {
        itens = await Protheus.connectAndQuery(`
          SELECT RTRIM(sc7.C7_ITEM) item, RTRIM(sc7.C7_PRODUTO) produto, RTRIM(sc7.C7_DESCRI) descricao,
                 RTRIM(sc7.C7_UM) um, sc7.C7_QUANT quantidade, sc7.C7_PRECO preco, sc7.C7_TOTAL total,
                 sc7.C7_QUJE recebido, RTRIM(sc7.C7_ENCER) encerrado, sc7.C7_DATPRF entrega,
                 RTRIM(sc7.C7_CC) cc, RTRIM(sc7.C7_CONTA) conta,
                 sc7.C7_MOEDA moeda, sc7.C7_TXMOEDA taxa, sc7.C7_EMISSAO emissao,
                 RTRIM(sc7.C7_FORNECE) forn, RTRIM(sc7.C7_LOJA) loja, RTRIM(sc7.C7_USER) compradorCod,
                 RTRIM(sc7.C7_COND) condCod,
                 RTRIM(COALESCE(sa2.A2_NREDUZ, sa2.A2_NOME, '')) fornNome, RTRIM(COALESCE(sa2.A2_CGC,'')) fornCgc,
                 RTRIM(COALESCE(e4.E4_DESCRI, '')) condDesc
            FROM SC7010 sc7 WITH (NOLOCK)
            LEFT JOIN SA2010 sa2 WITH (NOLOCK) ON sa2.A2_COD=sc7.C7_FORNECE AND sa2.A2_LOJA=sc7.C7_LOJA AND sa2.D_E_L_E_T_<>'*'
            LEFT JOIN SE4010 e4 WITH (NOLOCK) ON e4.E4_CODIGO=sc7.C7_COND AND e4.D_E_L_E_T_<>'*'
           WHERE sc7.C7_FILIAL='01' AND RTRIM(sc7.C7_NUM)=@num AND sc7.D_E_L_E_T_<>'*'
           ORDER BY sc7.C7_ITEM`, { num });
      } catch (err) {
        if (ehConexao(err)) return res.status(503).json({ message: MSG_INDISPONIVEL, conexao: true });
        throw err;
      }
      if (!itens.length) return res.status(404).json({ message: `Pedido de compra ${num} não encontrado.` });

      // 2) NF de entrada por item (SD1)
      const nfPorItem = new Map();
      try {
        const nfs = await Protheus.connectAndQuery(`
          SELECT RTRIM(D1_ITEMPC) item, RTRIM(D1_DOC) doc, RTRIM(D1_SERIE) serie
            FROM SD1010 WITH (NOLOCK)
           WHERE D_E_L_E_T_<>'*' AND D1_FILIAL='01' AND RTRIM(D1_DOC)<>'' AND RTRIM(D1_PEDIDO)=@num`, { num });
        nfs.forEach(r => { const k = trim(r.item); if (!nfPorItem.has(k)) nfPorItem.set(k, { nota: trim(r.doc), serie: trim(r.serie) }); });
      } catch (e) { console.warn('pedido-compra: SD1 err:', e.message); }

      // 3) Descrições de CC (CTT) e conta (CT1) — distintos do pedido
      const ccs = [...new Set(itens.map(i => trim(i.cc)).filter(Boolean))];
      const contas = [...new Set(itens.map(i => trim(i.conta)).filter(Boolean))];
      const ccDesc = new Map(), contaDesc = new Map();
      const buscarDesc = async (tabela, campoCod, campoDesc, valores, mapa) => {
        if (!valores.length) return;
        const inC = valores.map((_, k) => `@v${k}`).join(',');
        const p = {}; valores.forEach((v, k) => { p[`v${k}`] = v; });
        try {
          const rows = await Protheus.connectAndQuery(
            `SELECT RTRIM(${campoCod}) cod, RTRIM(${campoDesc}) descricao FROM ${tabela} WITH (NOLOCK)
              WHERE D_E_L_E_T_<>'*' AND RTRIM(${campoCod}) IN (${inC})`, p);
          rows.forEach(r => { if (!mapa.has(trim(r.cod))) mapa.set(trim(r.cod), trim(r.descricao)); });
        } catch (e) { console.warn(`pedido-compra: ${tabela} err:`, e.message); }
      };
      await buscarDesc('CTT010', 'CTT_CUSTO', 'CTT_DESC01', ccs, ccDesc);
      await buscarDesc('CT1010', 'CT1_CONTA', 'CT1_DESC01', contas, contaDesc);

      // 4) Nome do comprador (SYS_USR)
      const compradorCod = trim(itens[0].compradorCod);
      let compradorNome = compradorCod;
      if (compradorCod) {
        try {
          const u = await Protheus.connectAndQuery(
            `SELECT RTRIM(USR_NOME) nome FROM SYS_USR WHERE USR_ID=@id`, { id: compradorCod });
          if (u.length) compradorNome = trim(u[0].nome) || compradorCod;
        } catch (e) { /* mantém o código */ }
      }

      const h = itens[0];
      const totalMoeda = itens.reduce((s, i) => s + N(i.total), 0);
      const totalReais = itens.reduce((s, i) => s + emReais(i.total, i.moeda, i.taxa), 0);

      return res.json({
        pedido: num,
        emissao: trim(h.emissao),
        fornecedor: { cod: trim(h.forn), loja: trim(h.loja), nome: trim(h.fornNome), cgc: trim(h.fornCgc) },
        comprador: compradorNome,
        condicao: { cod: trim(h.condCod), descricao: trim(h.condDesc) },
        moeda: N(h.moeda), taxa: N(h.taxa),
        totalMoeda, totalReais,
        qtdItens: itens.length,
        itens: itens.map(i => {
          const nf = nfPorItem.get(trim(i.item));
          return {
            item: trim(i.item), produto: trim(i.produto), descricao: trim(i.descricao), um: trim(i.um),
            quantidade: N(i.quantidade), preco: N(i.preco), total: N(i.total), totalReais: emReais(i.total, i.moeda, i.taxa),
            moeda: N(i.moeda), taxa: N(i.taxa),
            cc: trim(i.cc), ccDesc: ccDesc.get(trim(i.cc)) || '', conta: trim(i.conta), contaDesc: contaDesc.get(trim(i.conta)) || '',
            recebido: N(i.recebido), encerrado: trim(i.encerrado) === 'E', entrega: trim(i.entrega),
            nota: nf ? nf.nota : '', serie: nf ? nf.serie : ''
          };
        }),
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('gerencia/pedido-compra:', err);
      return res.status(500).json({ message: 'Erro ao carregar o pedido: ' + err.message });
    }
  }
});

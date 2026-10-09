// GET /ciosp/catalogo?busca=autoclave&edicao=&tabela=&limite=30 — produtos com preço
// para montar orçamento e pedido no estande. Perm 19001.
//
// O talão de papel tem o produto escrito à mão ("G1 SF + Kit BV"), e é por isso que
// hoje não existe análise por produto. Aqui o vendedor busca e o preço vem pronto.
//
// DUAS FONTES, nesta ordem:
//   1) a lista de preço do evento (tab_ciosp_preco) — é onde mora o equipamento.
//      Medido em 09/10: nenhuma tabela do ERP precifica equipamento acabado (a maior
//      delas para em R$ 19,5 mil e o ticket médio do CIOSP é R$ 20 mil).
//   2) a tabela de preço do ERP (DA1) — boa para peça de reposição e assistência
//      técnica, que é a maior parte dela.
// O resultado vem com `fonte` para a tela deixar isso claro para o vendedor.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19001, 19002, 0]);
const { trim, N, n2 } = require('../../services/ciospDocs');

module.exports = (app) => ({
  verb: 'get',
  route: '/catalogo',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const busca = trim(req.query.busca);
    const edicao = trim(req.query.edicao) || 'CIOSP 2026';
    const tabela = trim(req.query.tabela) || process.env.CIOSP_TABELA_PADRAO || '009';
    const limite = Math.min(Math.max(Number(req.query.limite) || 30, 1), 100);

    if (busca.length < 2) {
      return res.status(400).json({ message: 'Digite ao menos 2 caracteres para buscar.' });
    }

    try {
      // 1) lista do evento
      let doEvento = [];
      try {
        doEvento = await Pg.connectAndQuery(
          `SELECT produto, descricao, modelo, familia, preco, preco_prazo, desconto_max, prazo_fabric
             FROM tab_ciosp_preco
            WHERE edicao = @edicao AND ativo = true
              AND (descricao ILIKE @q OR COALESCE(produto, '') ILIKE @qCod OR COALESCE(modelo, '') ILIKE @q)
            ORDER BY descricao
            LIMIT ${limite}`, { edicao, q: `%${busca}%`, qCod: `${busca}%` });
      } catch (e) {
        // Antes da migration 129 a tabela não existe — o catálogo segue pelo ERP.
        console.warn('ciosp/catalogo (lista do evento):', e.message);
      }

      const jaTem = new Set(doEvento.map(r => trim(r.produto)).filter(Boolean));
      const resto = Math.max(0, limite - doEvento.length);

      // 2) tabela do ERP
      let doErp = [];
      if (resto > 0) {
        doErp = await Protheus.connectAndQuery(`
          SELECT TOP ${resto}
                 RTRIM(b1.B1_COD) codigo, RTRIM(b1.B1_DESC) descricao,
                 RTRIM(b1.B1_UM) unidade, RTRIM(b1.B1_GRUPO) grupo,
                 ISNULL(da1.DA1_PRCVEN, 0) preco, ISNULL(da1.DA1_MAXDES, 0) desconto_max
            FROM SB1010 b1 WITH (NOLOCK)
            LEFT JOIN DA1010 da1 WITH (NOLOCK)
                   ON da1.DA1_CODTAB = @tabela AND da1.DA1_CODPRO = b1.B1_COD
                  AND da1.D_E_L_E_T_ <> '*'
           WHERE b1.D_E_L_E_T_ <> '*' AND b1.B1_MSBLQL <> '1'
             AND (RTRIM(b1.B1_COD) LIKE @qCod OR b1.B1_DESC LIKE @q)
           ORDER BY
             -- equipamento antes de peça: buscar "autoclave" na tabela do ERP trazia
             -- "abraçadeira de resistência de autoclave" na frente do aparelho.
             CASE WHEN RTRIM(b1.B1_GRUPO) = '0030' THEN 1 ELSE 0 END,
             CASE WHEN ISNULL(da1.DA1_PRCVEN, 0) > 0 THEN 0 ELSE 1 END,
             b1.B1_DESC`,
          { tabela, q: `%${busca}%`, qCod: `${busca}%` });
      }

      const itens = [
        ...doEvento.map(r => ({
          fonte: 'evento',
          codigo: trim(r.produto), descricao: trim(r.descricao), modelo: trim(r.modelo),
          familia: trim(r.familia), unidade: '', grupo: '',
          preco: n2(r.preco), preco_prazo: r.preco_prazo != null ? n2(r.preco_prazo) : null,
          desconto_max: n2(r.desconto_max), prazo_fabric: r.prazo_fabric,
          sem_preco: false
        })),
        ...doErp
          .filter(r => !jaTem.has(trim(r.codigo)))
          .map(r => ({
            fonte: 'erp',
            codigo: trim(r.codigo), descricao: trim(r.descricao), modelo: '',
            familia: trim(r.grupo) === '0030' ? 'Peças de reposição' : '',
            unidade: trim(r.unidade), grupo: trim(r.grupo),
            preco: n2(r.preco), preco_prazo: null,
            desconto_max: n2(r.desconto_max), prazo_fabric: null,
            // Sem preço na tabela o vendedor ainda pode usar, digitando o valor —
            // melhor que esconder o produto e ele escrever tudo à mão.
            sem_preco: N(r.preco) <= 0
          }))
      ];

      return res.json({
        edicao, tabela,
        tem_lista_do_evento: doEvento.length > 0,
        itens
      });
    } catch (err) {
      console.error('ciosp/catalogo:', err.message);
      return res.status(500).json({ message: 'Erro ao buscar produtos: ' + err.message });
    }
  }
});

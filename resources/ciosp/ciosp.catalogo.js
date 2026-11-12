// GET /ciosp/catalogo?busca=autoclave&edicao=&secao=&tabela=&limite=30 — produtos com preço
// para montar orçamento e pedido no estande. Perm 19001/19002/19004/19005.
//
// DUAS FONTES, nesta ordem:
//   1) a Tabela Comercial do evento (tab_ciosp_preco, migration 149) — uma linha por linha
//      impressa, com os 4 preços (13%/11% × 10x/6x), promoção e foto. O mesmo produto pode
//      aparecer em várias seções com preços diferentes (avulso × upgrade): cada linha volta.
//   2) a tabela de preço do ERP (DA1) — boa para peça de reposição e assistência técnica.
// O resultado vem com `fonte` para a tela deixar isso claro para o vendedor.
//
// Compatibilidade com a tela de orçamento atual: `codigo` é o B1_COD (vazio quando a linha
// não tem produto único no Protheus), `preco` = 13% 10x, `desconto_max` = % da promoção e
// `familia` = seção. O código como impresso vem em `codigo_impresso`.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19001, 19002, 19004, 19005, 0]);
const { trim, N, n2 } = require('../../services/ciospDocs');
const Edicao = require('../../services/ciospEdicao');
const Midia = require('../../services/ciospMidia');

module.exports = (app) => ({
  verb: 'get',
  route: '/catalogo',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const busca = trim(req.query.busca);
    const secao = trim(req.query.secao);
    const tabela = trim(req.query.tabela) || process.env.CIOSP_TABELA_PADRAO || '009';
    const limite = Math.min(Math.max(Number(req.query.limite) || 30, 1), 100);

    if (busca.length < 2 && !secao) {
      return res.status(400).json({ message: 'Digite ao menos 2 caracteres para buscar.' });
    }

    try {
      const edicao = trim(req.query.edicao) || (await Edicao.getConfig(app)).edicao || 'CIOSP 2026';

      // 1) Tabela Comercial do evento
      const [doEvento, fotos] = await Promise.all([
        Pg.connectAndQuery(
          `SELECT id, secao, grupo, tes, codigo, produto, descricao,
                  preco_13_10x, preco_13_6x, preco_11_10x, preco_11_6x,
                  promocao_texto, promocao_pct, promocao_condicional, prazo_fabric, foto_id
             FROM tab_ciosp_preco
            WHERE edicao = @edicao AND ativo
              AND (@secao = '' OR secao = @secao)
              AND (@busca = '' OR descricao ILIKE @q OR COALESCE(codigo, '') ILIKE @qCod
                   OR COALESCE(produto, '') ILIKE @qCod OR COALESCE(grupo, '') ILIKE @q)
            ORDER BY ordem
            LIMIT ${limite}`, { edicao, secao, busca, q: `%${busca}%`, qCod: `${busca}%` }),
        Pg.connectAndQuery(
          `SELECT id, codigo, arquivo FROM tab_ciosp_midia WHERE edicao = @edicao AND ativo AND tipo = 'foto'`, { edicao })
      ]);
      const arquivoDaFoto = new Map(fotos.map(f => [f.id, f.arquivo]));
      const fotosPorCodigo = fotos.filter(f => f.codigo);

      const jaTem = new Set(doEvento.map(r => trim(r.produto)).filter(Boolean));
      const resto = Math.max(0, limite - doEvento.length);

      // 2) tabela do ERP — só quando há texto de busca (filtrar por seção é só do evento)
      let doErp = [];
      if (resto > 0 && busca.length >= 2) {
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
        ...doEvento.map(r => {
          const fotoId = Midia.fotoDaLinha(r, fotosPorCodigo);
          const arquivo = fotoId ? arquivoDaFoto.get(fotoId) : null;
          const p = (v) => (v == null ? null : n2(v));
          return {
            fonte: 'evento', id: r.id,
            codigo: trim(r.produto), codigo_impresso: trim(r.codigo), produto: trim(r.produto) || null,
            descricao: trim(r.descricao), modelo: '', secao: r.secao, grupo: r.grupo, tes: r.tes,
            familia: trim(r.secao), unidade: '',
            precos: { '13_10x': p(r.preco_13_10x), '13_6x': p(r.preco_13_6x), '11_10x': p(r.preco_11_10x), '11_6x': p(r.preco_11_6x) },
            preco: p(r.preco_13_10x), preco_prazo: null,
            desconto_max: p(r.promocao_pct) || 0,
            promocao_texto: r.promocao_texto, promocao_pct: p(r.promocao_pct), promocao_condicional: !!r.promocao_condicional,
            prazo_fabric: r.prazo_fabric,
            foto_url: arquivo ? `/api/ciosp/midia-arquivo/${arquivo}` : null,
            sem_preco: false
          };
        }),
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

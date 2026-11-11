// GET /ciosp/precos?edicao=&busca=&secao= — linhas ativas da Tabela Comercial da
// edição, na ordem da tabela, mais as seções e as últimas importações. Perm 19004/19001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 19001, 0]);

module.exports = (app) => ({
  verb: 'get',
  route: '/precos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const edicao = String(req.query.edicao || '').trim();
    if (!edicao) return res.status(400).json({ message: 'Informe a edição.' });
    const busca = String(req.query.busca || '').trim();
    const secao = String(req.query.secao || '').trim();

    try {
      const [linhas, secoes, importacoes] = await Promise.all([
        Pg.connectAndQuery(
          `SELECT id, ordem, secao, grupo, tes, codigo, produto, descricao,
                  preco_13_10x, preco_13_6x, preco_11_10x, preco_11_6x,
                  promocao_texto, promocao_pct, promocao_condicional, prazo_fabric, foto_id
             FROM tab_ciosp_preco
            WHERE edicao = @edicao AND ativo
              AND (@secao = '' OR secao = @secao)
              AND (@busca = '' OR descricao ILIKE @q OR COALESCE(codigo, '') ILIKE @q OR COALESCE(grupo, '') ILIKE @q)
            ORDER BY ordem`,
          { edicao, secao, busca, q: `%${busca}%` }),
        Pg.connectAndQuery(
          `SELECT secao, COUNT(*)::int linhas, MIN(ordem) primeira
             FROM tab_ciosp_preco WHERE edicao = @edicao AND ativo AND secao IS NOT NULL
            GROUP BY secao ORDER BY primeira`, { edicao }),
        Pg.connectAndQuery(
          `SELECT i.id, i.arquivo, i.linhas, i.com_produto, i.criado_em, u.nome criado_por
             FROM tab_ciosp_preco_importacao i
             LEFT JOIN tab_intranet_usr u ON u.id = i.criado_por
            WHERE i.edicao = @edicao ORDER BY i.criado_em DESC LIMIT 5`, { edicao })
      ]);
      const num = (v) => (v == null ? null : Number(v));
      return res.json({
        edicao,
        linhas: linhas.map(l => ({
          id: l.id, ordem: l.ordem, secao: l.secao, grupo: l.grupo, tes: l.tes, codigo: l.codigo,
          produto: l.produto, descricao: l.descricao,
          preco_13_10x: num(l.preco_13_10x), preco_13_6x: num(l.preco_13_6x),
          preco_11_10x: num(l.preco_11_10x), preco_11_6x: num(l.preco_11_6x),
          promocao_texto: l.promocao_texto, promocao_pct: num(l.promocao_pct),
          promocao_condicional: !!l.promocao_condicional, prazo_fabric: l.prazo_fabric, foto_id: l.foto_id
        })),
        secoes: secoes.map(s => ({ secao: s.secao, linhas: s.linhas })),
        importacoes: importacoes.map(i => ({
          id: i.id, arquivo: i.arquivo, linhas: i.linhas, comProduto: i.com_produto,
          criadoEm: i.criado_em, criadoPor: i.criado_por
        }))
      });
    } catch (err) {
      console.error('ciosp/precos:', err.message);
      return res.status(500).json({ message: 'Erro ao listar a tabela: ' + err.message });
    }
  }
});

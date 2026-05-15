// GET /producao/instrucoes
// Lista produtos com instrucoes cadastradas + descricao do Protheus.
// Pra UI de cadastro/gestao.
//
// Filtros via query: busca (codigo OU descricao do produto)
// Permissao: 14002 (Producao - Admin) — engenharia/gestao cadastra.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14002]);

module.exports = (app) => ({
  verb: 'get',
  route: '/instrucoes',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    try {
      const busca = String(req.query.busca || '').trim().toUpperCase();

      // Agrega por produto: qtd instrucoes, lista de etapas cobertas, ultima
      // atualizacao
      const rows = await Pg.connectAndQuery(`
        SELECT produto_codigo,
               COUNT(*)                                   AS qtd,
               COUNT(*) FILTER (WHERE etapa_codigo IS NULL) AS qtd_geral,
               array_agg(etapa_codigo ORDER BY etapa_codigo NULLS FIRST) AS etapas,
               MAX(atualizado_em)                         AS atualizado_em
          FROM tab_prod_instrucao
         GROUP BY produto_codigo
         ORDER BY produto_codigo`,
        {}
      );
      if (!rows.length) return res.json({ produtos: [] });

      // Enriquece com descricao do Protheus (1 query batch via IN)
      const codigos = rows.map(r => r.produto_codigo);
      const placeholders = codigos.map((_, i) => `@p${i}`).join(',');
      const params = {};
      codigos.forEach((c, i) => { params[`p${i}`] = c; });
      const desc = await Protheus.connectAndQuery(`
        SELECT RTRIM(B1_COD) cod, RTRIM(B1_DESC) desc, RTRIM(B1_TIPO) tipo
          FROM SB1010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*'
           AND RTRIM(B1_COD) IN (${placeholders})`,
        params
      );
      const descMap = new Map(desc.map(d => [d.cod, { descricao: d.desc, tipo: d.tipo }]));

      let produtos = rows.map(r => ({
        produto_codigo: r.produto_codigo,
        descricao: descMap.get(r.produto_codigo)?.descricao || '(produto nao encontrado no Protheus)',
        tipo: descMap.get(r.produto_codigo)?.tipo || null,
        qtd: Number(r.qtd),
        qtd_geral: Number(r.qtd_geral),
        etapas: (r.etapas || []).filter(e => e != null),
        atualizado_em: r.atualizado_em
      }));

      if (busca) {
        produtos = produtos.filter(p =>
          p.produto_codigo.toUpperCase().includes(busca) ||
          (p.descricao || '').toUpperCase().includes(busca)
        );
      }

      return res.json({ produtos });
    } catch (err) {
      console.error('producao/instrucoes-list:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

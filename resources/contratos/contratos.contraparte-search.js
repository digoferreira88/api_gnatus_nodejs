// GET /contratos/contraparte-search?q=&tipo=
// Busca em SA1 (clientes) ou SA2 (fornecedores) do Protheus pra preencher o form.
// tipo = CLIENTE | FORNECEDOR
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5002]);
const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/contraparte-search',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const q = trim(req.query.q).toUpperCase();
    const tipo = trim(req.query.tipo).toUpperCase() || 'FORNECEDOR';
    if (q.length < 2) return res.json({ resultados: [] });

    try {
      let rows = [];
      if (tipo === 'CLIENTE') {
        rows = await Protheus.connectAndQuery(`
          SELECT TOP 25 RTRIM(A1_COD) cod, RTRIM(A1_LOJA) loja, RTRIM(A1_NOME) nome,
                 RTRIM(A1_CGC) cnpj, RTRIM(A1_EMAIL) email, RTRIM(A1_TEL) telefone,
                 RTRIM(A1_END) endereco, RTRIM(A1_MUN) municipio, RTRIM(A1_EST) uf,
                 'CLIENTE' AS tipo
            FROM SA1010 WITH (NOLOCK)
           WHERE D_E_L_E_T_ <> '*'
             AND (UPPER(A1_NOME) LIKE '%' + @q + '%' OR RTRIM(A1_COD) = @q OR REPLACE(A1_CGC, ' ', '') LIKE @q + '%')
           ORDER BY A1_NOME`, { q });
      } else {
        rows = await Protheus.connectAndQuery(`
          SELECT TOP 25 RTRIM(A2_COD) cod, RTRIM(A2_LOJA) loja, RTRIM(A2_NOME) nome,
                 RTRIM(A2_CGC) cnpj, RTRIM(A2_EMAIL) email, RTRIM(A2_TEL) telefone,
                 RTRIM(A2_END) endereco, RTRIM(A2_MUN) municipio, RTRIM(A2_EST) uf,
                 'FORNECEDOR' AS tipo
            FROM SA2010 WITH (NOLOCK)
           WHERE D_E_L_E_T_ <> '*'
             AND (UPPER(A2_NOME) LIKE '%' + @q + '%' OR RTRIM(A2_COD) = @q OR REPLACE(A2_CGC, ' ', '') LIKE @q + '%')
           ORDER BY A2_NOME`, { q });
      }
      return res.json({
        resultados: rows.map(r => ({
          cod: trim(r.cod), loja: trim(r.loja), nome: trim(r.nome),
          cnpj: trim(r.cnpj), email: trim(r.email), telefone: trim(r.telefone),
          endereco: [trim(r.endereco), trim(r.municipio), trim(r.uf)].filter(Boolean).join(' · '),
          tipo: trim(r.tipo)
        }))
      });
    } catch (err) {
      console.error('contratos/contraparte-search:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

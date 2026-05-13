// GET /compras/produto-buscar?q=...
//
// Autocomplete de produto pra tela de Solicitar Compra. Busca em SB1010 por
// codigo OU descricao (LIKE). Limita 50 resultados pra UI ficar leve.
// Permissao 4004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([4004]);

const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/produto-buscar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const q = trim(req.query.q).toUpperCase();
    if (q.length < 2) {
      return res.json({ produtos: [] });
    }

    try {
      const rows = await Protheus.connectAndQuery(`
        SELECT TOP 50
               RTRIM(B1_COD)     codigo,
               RTRIM(B1_DESC)    descricao,
               RTRIM(B1_TIPO)    tipo,
               RTRIM(B1_GRUPO)   grupo,
               RTRIM(B1_UM)      unidade,
               RTRIM(B1_LOCPAD)  armazem_padrao,
               B1_PRV1           preco_referencia
          FROM SB1010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*'
           AND (UPPER(B1_DESC) LIKE '%' + @q + '%' OR B1_COD LIKE @q + '%')
         ORDER BY B1_COD`,
        { q }
      );
      return res.json({
        produtos: rows.map(r => ({
          codigo:    trim(r.codigo),
          descricao: trim(r.descricao),
          tipo:      trim(r.tipo),
          grupo:     trim(r.grupo),
          unidade:   trim(r.unidade),
          armazem_padrao:   trim(r.armazem_padrao) || '01',
          preco_referencia: Number(r.preco_referencia || 0)
        }))
      });
    } catch (err) {
      console.error('compras/produto-buscar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// GET /compras/centros-custo?q=
//
// Lista centros de custo (CTT010) — codigo + descricao. Filtra por busca
// quando ?q= fornecido. Permissao 4004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([4004]);

const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/centros-custo',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const q = trim(req.query.q).toUpperCase();

    let where = '';
    const params = {};
    if (q) {
      where = `AND (UPPER(CTT_DESC01) LIKE '%' + @q + '%' OR CTT_CUSTO LIKE @q + '%')`;
      params.q = q;
    }

    try {
      // CTT010 pode ter o mesmo CTT_CUSTO em multiplas filiais (chave composta
      // CTT_FILIAL+CTT_CUSTO). DISTINCT colapsa em 1 linha por (codigo, descricao).
      const rows = await Protheus.connectAndQuery(`
        SELECT DISTINCT TOP 200
               RTRIM(CTT_CUSTO)   codigo,
               RTRIM(CTT_DESC01)  descricao
          FROM CTT010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*'
           AND (CTT_BLOQ IS NULL OR RTRIM(CTT_BLOQ) <> '1')
           ${where}
         ORDER BY RTRIM(CTT_CUSTO)`,
        params
      );
      return res.json({
        centros: rows.map(r => ({
          codigo:    trim(r.codigo),
          descricao: trim(r.descricao)
        }))
      });
    } catch (err) {
      console.error('compras/centros-custo:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

const trim = (v) => String(v || '').trim();

// Remove máscara de CPF/CNPJ deixando só dígitos
const onlyDigits = (v) => String(v || '').replace(/\D/g, '');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6001, 6002]);

module.exports = (app) => ({
  verb: 'get',
  route: '/clientes',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const { q } = req.query;
    const query = trim(q);

    if (!query || query.length < 2) {
      return res.status(400).json({ message: 'Informe pelo menos 2 caracteres para buscar.' });
    }

    const digits = onlyDigits(query);
    const params = { q: query, qLike: `%${query.toUpperCase()}%`, digits };

    // Detecta o que foi digitado:
    //  - >= 11 dígitos: trata como CPF/CNPJ (busca exata por A1_CGC)
    //  - 3..10 dígitos: trata como código (A1_COD)
    //  - qualquer coisa: busca por nome/razão social
    let cond = '';
    if (digits.length >= 11) {
      cond = `AND a1.A1_CGC LIKE '%' + @digits + '%'`;
    } else if (digits.length >= 3 && digits === query) {
      cond = `AND (a1.A1_COD LIKE '%' + @digits + '%' OR a1.A1_CGC LIKE '%' + @digits + '%')`;
    } else {
      cond = `AND (UPPER(a1.A1_NOME) LIKE @qLike OR UPPER(a1.A1_NREDUZ) LIKE @qLike)`;
    }

    const sql = `
      SELECT TOP 25
        RTRIM(a1.A1_COD)    AS codigo,
        RTRIM(a1.A1_LOJA)   AS loja,
        RTRIM(a1.A1_NOME)   AS nome,
        RTRIM(a1.A1_NREDUZ) AS nomeReduzido,
        RTRIM(a1.A1_CGC)    AS cgc,
        RTRIM(a1.A1_PESSOA) AS tipoPessoa,
        RTRIM(a1.A1_MUN)    AS municipio,
        RTRIM(a1.A1_EST)    AS estado,
        RTRIM(a1.A1_EMAIL)  AS email,
        RTRIM(a1.A1_DDD)    AS ddd,
        RTRIM(a1.A1_TEL)    AS telefone,
        RTRIM(a1.A1_VEND)   AS vendedor,
        RTRIM(sa3.A3_NOME)  AS vendedorNome,
        RTRIM(a1.A1_MSBLQL) AS bloqueado
      FROM SA1010 a1 WITH (NOLOCK)
      LEFT JOIN SA3010 sa3 WITH (NOLOCK)
        ON sa3.A3_COD = a1.A1_VEND AND sa3.D_E_L_E_T_ <> '*'
      WHERE a1.D_E_L_E_T_ <> '*'
        ${cond}
      ORDER BY a1.A1_NOME
    `;

    try {
      const rows = await Protheus.connectAndQuery(sql, params);
      return res.json(rows);
    } catch (error) {
      console.error('Erro em sac/clientes:', error);
      return res.status(500).json({ message: 'Erro ao buscar clientes.' });
    }
  }
});

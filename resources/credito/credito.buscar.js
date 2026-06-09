// GET /credito/buscar?q=<nome | cpf | cnpj | codigo>
// Resolve um termo -> cliente(s) no Protheus (SA1). Aceita:
//   - CPF (11) / CNPJ (14): match exato por A1_CGC (com/sem máscara)
//   - nome (>=3 chars): LIKE em A1_NOME / A1_NREDUZ, ou código exato (A1_COD)
// Para autocomplete: limita a 30 resultados, ordenado por nome. Permissão 15100.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([15100]);
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/buscar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const q = trim(req.query.q || req.query.doc);
    const digits = q.replace(/\D/g, '');

    let cond, params = {};
    if (digits.length === 11 || digits.length === 14) {
      cond = `REPLACE(REPLACE(REPLACE(REPLACE(RTRIM(A1_CGC),'.',''),'/',''),'-',''),' ','') = @doc`;
      params.doc = digits;
    } else if (q.length >= 3) {
      cond = `(UPPER(RTRIM(A1_NOME)) LIKE '%' + @q + '%' OR UPPER(RTRIM(A1_NREDUZ)) LIKE '%' + @q + '%' OR RTRIM(A1_COD) = @cod)`;
      params.q = q.toUpperCase();
      params.cod = q;
    } else {
      return res.status(400).json({ message: 'Digite ao menos 3 letras do nome, ou um CPF/CNPJ completo.' });
    }

    try {
      const rows = await Protheus.connectAndQuery(
        `SELECT TOP 30 RTRIM(A1_COD) cod, RTRIM(A1_LOJA) loja, RTRIM(A1_NOME) nome, RTRIM(A1_NREDUZ) fantasia,
                RTRIM(A1_CGC) cnpj, RTRIM(A1_EST) uf, A1_LC limite, RTRIM(A1_MSBLQL) bloqueado
           FROM SA1010 WITH (NOLOCK)
          WHERE D_E_L_E_T_ <> '*' AND ${cond}
          ORDER BY A1_NOME, A1_COD, A1_LOJA`, params);

      const clientes = rows.map(r => ({
        cod: trim(r.cod), loja: trim(r.loja), nome: trim(r.nome), fantasia: trim(r.fantasia),
        cnpj: trim(r.cnpj), uf: trim(r.uf), limite: Number(r.limite || 0), bloqueado: trim(r.bloqueado) === '1'
      }));
      return res.json({ q, total: clientes.length, clientes });
    } catch (err) {
      console.error('Erro credito/buscar:', err);
      return res.status(500).json({ message: 'Erro ao buscar cliente: ' + err.message });
    }
  }
});

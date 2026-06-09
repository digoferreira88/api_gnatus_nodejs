// GET /credito/buscar?doc=<cpf|cnpj>
// Resolve um CPF/CNPJ -> cliente(s) no Protheus (SA1, por A1_CGC). Um mesmo
// documento pode ter várias lojas/códigos. Permissão 15100.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([15100]);
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/buscar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const doc = String(req.query.doc || '').replace(/\D/g, '');
    if (doc.length !== 11 && doc.length !== 14) {
      return res.status(400).json({ message: 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).' });
    }
    try {
      const rows = await Protheus.connectAndQuery(
        `SELECT RTRIM(A1_COD) cod, RTRIM(A1_LOJA) loja, RTRIM(A1_NOME) nome, RTRIM(A1_NREDUZ) fantasia,
                RTRIM(A1_CGC) cnpj, RTRIM(A1_EST) uf, A1_LC limite, RTRIM(A1_MSBLQL) bloqueado
           FROM SA1010 WITH (NOLOCK)
          WHERE D_E_L_E_T_ <> '*'
            AND REPLACE(REPLACE(REPLACE(REPLACE(RTRIM(A1_CGC),'.',''),'/',''),'-',''),' ','') = @doc
          ORDER BY A1_COD, A1_LOJA`, { doc });

      const clientes = rows.map(r => ({
        cod: trim(r.cod), loja: trim(r.loja), nome: trim(r.nome), fantasia: trim(r.fantasia),
        cnpj: trim(r.cnpj), uf: trim(r.uf), limite: Number(r.limite || 0), bloqueado: trim(r.bloqueado) === '1'
      }));
      return res.json({ doc, total: clientes.length, clientes });
    } catch (err) {
      console.error('Erro credito/buscar:', err);
      return res.status(500).json({ message: 'Erro ao buscar cliente: ' + err.message });
    }
  }
});

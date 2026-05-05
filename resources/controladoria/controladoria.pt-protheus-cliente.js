// GET /controladoria/pt/protheus/cliente?q=texto
// Autocomplete de cliente em SA1010. Busca por codigo OU nome.
// Permissao 11003.

const trim = (v) => String(v || '').trim();
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/pt/protheus/cliente',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const termo = trim(req.query.q);
    if (termo.length < 2) return res.json({ clientes: [] });

    try {
      const rows = await Protheus.connectAndQuery(`
        SELECT TOP 25
          RTRIM(A1_COD) cod, RTRIM(A1_LOJA) loja, RTRIM(A1_NOME) nome,
          RTRIM(A1_NREDUZ) nome_reduzido, RTRIM(A1_MUN) municipio, RTRIM(A1_EST) uf,
          RTRIM(A1_DDD) ddd, RTRIM(A1_TEL) tel, RTRIM(A1_DDDCEL) dddcel
        FROM SA1010 WITH (NOLOCK)
        WHERE D_E_L_E_T_ <> '*'
          AND (A1_COD LIKE @t + '%' OR UPPER(A1_NOME) LIKE '%' + UPPER(@t) + '%')
        ORDER BY A1_COD, A1_LOJA`,
        { t: termo }
      );
      return res.json({
        clientes: rows.map(r => ({
          cod: trim(r.cod),
          loja: trim(r.loja),
          nome: trim(r.nome),
          nome_reduzido: trim(r.nome_reduzido),
          municipio: trim(r.municipio),
          uf: trim(r.uf),
          ddd: trim(r.ddd),
          tel: trim(r.tel),
          dddcel: trim(r.dddcel),
          label: `${trim(r.cod)}/${trim(r.loja)} — ${trim(r.nome)}${r.uf ? ` (${trim(r.uf)})` : ''}`
        }))
      });
    } catch (err) {
      console.error('pt-protheus-cliente:', err);
      return res.status(500).json({ message: 'Erro ao consultar Protheus: ' + err.message });
    }
  }
});

// Lista anexos de um cliente.
// GET /cobranca/cliente/:cod/:loja/anexos

module.exports = (app) => ({
  verb: 'get',
  route: '/cliente/:cod/:loja/anexos',
  middlewares: [require('../../middlewares/requirePerm')(app)([9001, 9002])],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const cod = String(req.params.cod || '').trim();
    const loja = String(req.params.loja || '').trim();
    if (!cod || !loja) return res.status(400).json({ message: 'cod/loja obrigatorios.' });

    try {
      const rows = await Pg.connectAndQuery(
        `SELECT a.id, a.titulo, a.arquivo_nome_original AS nome,
                a.arquivo_tamanho AS tamanho, a.arquivo_mime AS mime,
                a.enviado_em, u.nome AS enviado_por_nome
           FROM tab_cobranca_anexo a
           LEFT JOIN tab_intranet_usr u ON u.id = a.enviado_por
          WHERE a.cliente_cod = @cod AND a.cliente_loja = @loja
          ORDER BY a.enviado_em DESC`,
        { cod, loja }
      );
      return res.json({ total: rows.length, anexos: rows });
    } catch (err) {
      console.error('Erro cobranca/anexos list:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

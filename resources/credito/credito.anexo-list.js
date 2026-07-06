// GET /credito/anexos/:cod/:loja — lista as consultas externas anexadas de um
// cliente na Análise de Crédito. Perm 15100.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([15100]);
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/anexos/:cod/:loja',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const cod = trim(req.params.cod), loja = trim(req.params.loja);
    if (!cod || !loja) return res.status(400).json({ message: 'cod e loja sao obrigatorios.' });

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT a.id, a.titulo, a.nome_original, a.mime_type, a.tamanho_bytes,
               a.enviado_em, a.enviado_por, u.nome AS enviado_por_nome
          FROM tab_credito_anexo a
          LEFT JOIN tab_intranet_usr u ON u.id = a.enviado_por
         WHERE a.cliente_cod = @cod AND a.cliente_loja = @loja
         ORDER BY a.enviado_em DESC`,
        { cod, loja });
      return res.json(rows);
    } catch (err) {
      console.error('Erro credito/anexos:', err);
      return res.status(500).json({ message: 'Erro ao listar anexos: ' + err.message });
    }
  }
});

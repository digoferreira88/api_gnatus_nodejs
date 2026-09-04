// GET /fiscal/nfse-recebidas/:chave/xml
// Devolve o XML autorizado da NFS-e recebida (guardado no ADN sync). Perm 16001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);

module.exports = (app) => ({
  verb: 'get',
  route: '/nfse-recebidas/:chave/xml',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const chave = String(req.params.chave || '').replace(/\D/g, '');
    if (chave.length !== 50) return res.status(400).json({ message: 'Chave de NFS-e inválida (esperado 50 dígitos).' });

    try {
      const rows = await Pg.connectAndQuery(
        `SELECT xml, numero FROM tab_nfse_recebida WHERE chave=@c`, { c: chave });
      if (!rows.length || !rows[0].xml) {
        return res.status(404).json({ message: 'XML da NFS-e não encontrado.' });
      }
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="NFSe_${chave}.xml"`);
      return res.send(rows[0].xml);
    } catch (err) {
      console.error('fiscal/nfse-recebida-xml:', err.message);
      return res.status(500).json({ message: 'Erro ao ler XML: ' + err.message });
    }
  }
});

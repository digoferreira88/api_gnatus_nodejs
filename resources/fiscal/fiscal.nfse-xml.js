// GET /fiscal/nfse/xml?id=<id>&tipo=dps|nfse
// Baixa o XML da emissão: 'dps' = DPS assinado enviado; 'nfse' = NFS-e retornada
// pela prefeitura. Perm 16001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/nfse/xml',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.query.id);
    const tipo = trim(req.query.tipo).toLowerCase() === 'nfse' ? 'nfse' : 'dps';
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id inválido.' });

    const col = tipo === 'nfse' ? 'nfse_xml' : 'dps_xml';
    const rows = await Pg.connectAndQuery(
      `SELECT ${col} AS xml, doc, serie FROM tab_nfse_emitida WHERE id=@id`, { id });
    if (!rows.length) return res.status(404).json({ message: 'Emissão não encontrada.' });
    const xml = rows[0].xml;
    if (!xml) return res.status(404).json({ message: `Sem XML ${tipo} para esta emissão.` });

    const nome = `nfse-${tipo}-${trim(rows[0].serie)}${trim(rows[0].doc)}-${id}.xml`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    return res.send(xml);
  }
});

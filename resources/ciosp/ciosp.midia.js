// GET /ciosp/midia?edicao= — fotos e catálogos ativos da edição, com a URL de cada um
// e as linhas da tabela que têm foto própria. Perm 19004/19001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 19001, 0]);

const url = (arquivo) => `/api/ciosp/midia-arquivo/${arquivo}`;

module.exports = (app) => ({
  verb: 'get',
  route: '/midia',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const edicao = String(req.query.edicao || '').trim();
    if (!edicao) return res.status(400).json({ message: 'Informe a edição.' });
    try {
      const [midia, linhas] = await Promise.all([
        Pg.connectAndQuery(
          `SELECT m.id, m.tipo, m.titulo, m.arquivo, m.mime, m.bytes, m.codigo, m.secao, m.enviado_em,
                  u.nome enviado_por
             FROM tab_ciosp_midia m LEFT JOIN tab_intranet_usr u ON u.id = m.enviado_por
            WHERE m.edicao = @edicao AND m.ativo
            ORDER BY m.tipo, COALESCE(m.secao, m.codigo, ''), m.titulo`, { edicao }),
        Pg.connectAndQuery(
          `SELECT id, foto_id, descricao FROM tab_ciosp_preco
            WHERE edicao = @edicao AND ativo AND foto_id IS NOT NULL`, { edicao })
      ]);
      return res.json({
        itens: midia.map(m => ({
          id: m.id, tipo: m.tipo, titulo: m.titulo, arquivo: m.arquivo, url: url(m.arquivo), mime: m.mime,
          bytes: m.bytes, codigo: m.codigo, secao: m.secao, enviadoEm: m.enviado_em, enviadoPor: m.enviado_por,
          linhas: linhas.filter(l => l.foto_id === m.id).map(l => ({ id: l.id, descricao: l.descricao }))
        })),
        bytesTotal: midia.reduce((s, m) => s + Number(m.bytes || 0), 0)
      });
    } catch (err) {
      console.error('ciosp/midia:', err.message);
      return res.status(500).json({ message: 'Erro ao listar fotos e catálogos: ' + err.message });
    }
  }
});

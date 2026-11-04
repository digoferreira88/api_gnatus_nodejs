// GET /financeiro/credito-registro/:grupo/historico
// Todas as versões de uma análise (do mais recente ao mais antigo) + os anexos
// vinculados ao grupo. Perm 8006 (edição) ou 8007 (somente visualização).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006, 8007]);
const CR = require('../../services/creditoRegistro');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/credito-registro/:grupo/historico',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const grupo = Number(req.params.grupo);
    if (!Number.isInteger(grupo) || grupo <= 0) return res.status(400).json({ message: 'grupo inválido.' });

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT ${CR.COLS}
          FROM tab_credito_registro r
         WHERE r.grupo_id = @g
         ORDER BY r.versao DESC`, { g: grupo });
      if (!rows.length) return res.status(404).json({ message: 'Análise não encontrada.' });

      const anexos = await Pg.connectAndQuery(`
        SELECT a.id, a.titulo, a.nome_original, a.mime_type, a.tamanho_bytes, a.url, a.enviado_em,
               u.nome AS enviado_por_nome
          FROM tab_credito_anexo a
          LEFT JOIN tab_intranet_usr u ON u.id = a.enviado_por
         WHERE a.registro_id = @g
         ORDER BY a.enviado_em DESC`, { g: grupo });

      return res.json({
        grupoId: grupo,
        versoes: rows.map(CR.mapRegistro),
        anexos: anexos.map(a => ({
          id: a.id, titulo: trim(a.titulo), nomeOriginal: trim(a.nome_original),
          mimeType: trim(a.mime_type), tamanhoBytes: N(a.tamanho_bytes),
          url: trim(a.url), enviadoEm: a.enviado_em, enviadoPor: trim(a.enviado_por_nome)
        }))
      });
    } catch (err) {
      console.error('financeiro/credito-registro historico:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

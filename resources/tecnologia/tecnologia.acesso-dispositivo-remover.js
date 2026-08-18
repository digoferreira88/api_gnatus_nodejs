// DELETE /tecnologia/acesso-dispositivos/:id — remove um controlador VAZIO.
// Com posições ocupadas recusa (libere/mova as tags antes) — proteção contra
// perder um cadastro inteiro num clique. Perm 1034. Auditado.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1034]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'delete',
  route: '/acesso-dispositivos/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'id inválido.' });

    try {
      const ocup = await Pg.connectAndQuery(
        `SELECT COUNT(*)::int n FROM tab_acesso_tag WHERE dispositivo_id = @id`, { id });
      if (ocup[0].n > 0) {
        return res.status(409).json({ message: `Este controlador tem ${ocup[0].n} posição(ões) ocupada(s). Libere as tags antes de removê-lo.` });
      }
      const del = await Pg.connectAndQuery(
        `DELETE FROM tab_acesso_dispositivo WHERE id = @id RETURNING nome`, { id });
      if (!del.length) return res.status(404).json({ message: 'Controlador não encontrado.' });

      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'AcessoTags', acao: 'DISPOSITIVO_REMOVER', severidade: 'ALERTA', req,
        entidade: 'acesso_dispositivo', entidadeId: String(id),
        descricao: `Removeu o controlador "${String(del[0].nome).trim()}" (estava vazio)`
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('tecnologia/acesso-dispositivo-remover:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

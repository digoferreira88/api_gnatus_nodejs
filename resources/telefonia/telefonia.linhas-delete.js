// DELETE /telefonia/linhas/:id — remove fisicamente a linha (cascata o historico).
// Para "cancelar" preservando historico, use PUT com status='Cancelada'.
// Permissao 1027.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1027]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'delete',
  route: '/linhas/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'id invalido.' });
    }

    try {
      const cur = await Pg.connectAndQuery(
        `SELECT id, numero_telefone, pessoa, plano FROM tab_telefonia_linha WHERE id = @id`, { id }
      );
      if (!cur.length) return res.status(404).json({ message: 'Linha nao encontrada.' });
      const l = cur[0];

      await Pg.connectAndQuery(`DELETE FROM tab_telefonia_linha WHERE id = @id`, { id });

      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'TelefoniaMovel',
        acao: 'DELETE', severidade: 'ALERTA',
        req, entidade: 'telefonia_linha', entidadeId: String(id),
        descricao: `Excluiu linha ${l.numero_telefone}${l.pessoa ? ' (' + l.pessoa + ')' : ''}`,
        antes: { numero_telefone: l.numero_telefone, pessoa: l.pessoa, plano: l.plano }
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('telefonia/linhas delete:', err);
      return res.status(500).json({ message: 'Erro ao excluir: ' + err.message });
    }
  }
});

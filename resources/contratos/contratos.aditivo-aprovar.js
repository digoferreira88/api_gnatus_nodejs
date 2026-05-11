// PUT /contratos/:id/aditivos/:aid/aprovar
// Aprova um aditivo: marca como APROVADO e aplica os valores no contrato pai
// (atualiza valor_total / valor_mensal / vigencia_fim conforme campos preenchidos
// no aditivo). Permissao 5004.
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5004]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'put',
  route: '/:id/aditivos/:aid/aprovar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id  = Number(req.params.id);
    const aid = Number(req.params.aid);
    try {
      const aRows = await Pg.connectAndQuery(
        `SELECT * FROM tab_contrato_aditivo WHERE id = @aid AND id_contrato = @id`, { aid, id }
      );
      if (!aRows.length) return res.status(404).json({ message: 'Aditivo nao encontrado.' });
      const a = aRows[0];
      if (a.status === 'APROVADO') return res.status(409).json({ message: 'Aditivo ja aprovado.' });
      if (a.status === 'CANCELADO') return res.status(409).json({ message: 'Aditivo cancelado nao pode ser aprovado.' });

      // Aplica no contrato (so os campos que vieram preenchidos no aditivo)
      const sets = [];
      const params = { id };
      if (a.valor_total_novo != null)  { sets.push(`valor_total = @vt`);  params.vt = a.valor_total_novo; }
      if (a.valor_mensal_novo != null) { sets.push(`valor_mensal = @vm`); params.vm = a.valor_mensal_novo; }
      if (a.vigencia_fim_novo != null) { sets.push(`vigencia_fim = @vf::date`); params.vf = a.vigencia_fim_novo; }
      if (sets.length) {
        sets.push(`id_user_atualizou = @uid`);
        sets.push(`atualizado_em = NOW()`);
        params.uid = user?.ID || null;
        await Pg.connectAndQuery(`UPDATE tab_contrato SET ${sets.join(', ')} WHERE id = @id`, params);
      }

      // Aprova o aditivo
      await Pg.connectAndQuery(
        `UPDATE tab_contrato_aditivo SET status = 'APROVADO', id_user_aprovador = @uid, aprovado_em = NOW()
          WHERE id = @aid`,
        { aid, uid: user?.ID || null }
      );

      Auditoria.registrar(app, {
        modulo: 'ApoioGerencial', submodulo: 'Contratos',
        acao: 'ADITIVO_APROVAR', severidade: 'CRITICO',
        req, entidade: 'contrato_aditivo', entidadeId: String(aid),
        descricao: `Aprovou aditivo ${a.numero}/${a.tipo} do contrato ${id} — campos alterados: ${sets.filter(s => !s.startsWith('id_user') && !s.startsWith('atualizado')).map(s => s.split(' ')[0]).join(', ')}`,
        meta: { contrato_id: id, aditivo_id: aid, tipo: a.tipo, valor_total_novo: a.valor_total_novo, valor_mensal_novo: a.valor_mensal_novo, vigencia_fim_novo: a.vigencia_fim_novo }
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('aditivo-aprovar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

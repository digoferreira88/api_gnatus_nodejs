// PUT /tecnologia/protheus-import/layouts/:id — edita (apenas o dono).
// Permissao 1031.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1031]);
const trim = (v) => v == null ? null : String(v).trim() || null;

module.exports = (app) => ({
  verb: 'put',
  route: '/protheus-import/layouts/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    const b = req.body || {};
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });

    try {
      const dono = await Pg.connectAndQuery(
        `SELECT criado_por FROM tab_protheus_import_layout WHERE id = @id`, { id }
      );
      if (!dono.length) return res.status(404).json({ message: 'Layout nao encontrado.' });
      if (Number(dono[0].criado_por) !== Number(user.ID)) {
        return res.status(403).json({ message: 'Apenas o dono pode editar.' });
      }

      const sets = [];
      const params = { id };
      const editaveis = { nome: 'nome', notas: 'notas', visibilidade: 'visibilidade' };
      for (const [chave, col] of Object.entries(editaveis)) {
        if (chave in b) { sets.push(`${col} = @${col}`); params[col] = trim(b[chave]); }
      }
      if (Array.isArray(b.campos)) {
        sets.push(`campos = @campos::jsonb`);
        params.campos = JSON.stringify(b.campos);
      }
      if ('tabela' in b) { sets.push(`tabela = @tabela`); params.tabela = trim(b.tabela); }
      if ('modelo_id' in b) { sets.push(`modelo_id = @mid`); params.mid = Number(b.modelo_id); }
      if ('modelo_nome' in b) { sets.push(`modelo_nome = @mnome`); params.mnome = trim(b.modelo_nome); }

      if (!sets.length) return res.status(400).json({ message: 'Nenhum campo pra atualizar.' });
      sets.push(`atualizado_em = NOW()`);

      await Pg.connectAndQuery(`UPDATE tab_protheus_import_layout SET ${sets.join(', ')} WHERE id = @id`, params);
      return res.json({ ok: true });
    } catch (err) {
      console.error('protheus-import-layout update:', err);
      return res.status(500).json({ message: 'Erro ao editar layout: ' + err.message });
    }
  }
});

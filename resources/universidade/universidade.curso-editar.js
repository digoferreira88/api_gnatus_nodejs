// Atualiza curso. Instrutor edita os proprios; admin edita qualquer.
// PATCH /universidade/curso/:id
// Body: { titulo?, descricao?, categoriaId?, capaUrl?, cargaHorariaH?, publico?, ativo? }

const trim = (v) => v == null ? null : String(v).trim();
const { ehInstrutor, ehAdmin } = require('./_perms');

module.exports = (app) => ({
  verb: 'patch',
  route: '/curso/:id',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });
    if (!(await ehInstrutor(Pg, user.ID))) return res.status(403).json({ message: 'Sem permissao (15002 ou 15003).' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID invalido.' });

    const c = await Pg.connectAndQuery(`SELECT instrutor_id FROM tab_uni_curso WHERE id = @id`, { id });
    if (!c.length) return res.status(404).json({ message: 'Curso nao encontrado.' });
    const isOwner = Number(c[0].instrutor_id) === Number(user.ID);
    const isAdmin = await ehAdmin(Pg, user.ID);
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Voce nao eh dono nem admin deste curso.' });

    const sets = [];
    const params = { id };
    const map = {
      titulo: 'titulo', descricao: 'descricao', categoriaId: 'categoria_id',
      capaUrl: 'capa_url', cargaHorariaH: 'carga_horaria_h',
      publico: 'publico', ativo: 'ativo'
    };
    if ('descricao' in req.body && trim(req.body.descricao).length < 10) {
      return res.status(400).json({ message: 'Preencha a descrição (conteúdo programático) do curso — ela vai no verso do certificado.' });
    }
    for (const [k, col] of Object.entries(map)) {
      if (k in req.body) {
        const v = req.body[k];
        sets.push(`${col} = @${k}`);
        if (k === 'cargaHorariaH') params[k] = Number(v);
        else if (k === 'categoriaId') params[k] = v == null ? null : Number(v);
        else if (k === 'publico' || k === 'ativo') params[k] = !!v;
        else params[k] = trim(v);
      }
    }
    if (!sets.length) return res.status(400).json({ message: 'Nada a atualizar.' });
    sets.push('atualizado_em = NOW()');

    try {
      await Pg.connectAndQuery(
        `UPDATE tab_uni_curso SET ${sets.join(', ')} WHERE id = @id`, params
      );
      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro universidade/curso PATCH:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

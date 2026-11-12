// Cria novo curso. Permissao: instrutor (15002) ou admin (15003).
// POST /universidade/curso
// Body: { codigo, titulo, descricao?, categoriaId?, capaUrl?, cargaHorariaH?, publico? }

const trim = (v) => v == null ? null : String(v).trim();
const { ehInstrutor } = require('./_perms');

module.exports = (app) => ({
  verb: 'post',
  route: '/curso',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Nao autenticado.' });
    if (!(await ehInstrutor(Pg, user.ID))) return res.status(403).json({ message: 'Sem permissao (15002 ou 15003).' });

    const codigo = trim(req.body?.codigo);
    const titulo = trim(req.body?.titulo);
    if (!codigo || !titulo) return res.status(400).json({ message: 'codigo e titulo obrigatorios.' });
    if (trim(req.body?.descricao).length < 10) return res.status(400).json({ message: 'Preencha a descrição (conteúdo programático) do curso — ela vai no verso do certificado.' });

    const params = {
      codigo: codigo.toUpperCase(),
      titulo,
      descricao: trim(req.body?.descricao),
      cat: req.body?.categoriaId != null ? Number(req.body.categoriaId) : null,
      capa: trim(req.body?.capaUrl),
      ch: req.body?.cargaHorariaH != null ? Number(req.body.cargaHorariaH) : 1,
      publico: req.body?.publico !== false,
      iid: user.ID,
      inome: user.NOME || user.EMAIL || ''
    };

    try {
      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_uni_curso
          (codigo, titulo, descricao, categoria_id, instrutor_id, instrutor_nome,
           capa_url, carga_horaria_h, publico)
        VALUES (@codigo, @titulo, @descricao, @cat, @iid, @inome, @capa, @ch, @publico)
        RETURNING id`,
        params
      );
      return res.json({ ok: true, id: ins[0].id });
    } catch (err) {
      if (String(err.message).includes('duplicate key')) {
        return res.status(409).json({ message: `Codigo ${params.codigo} ja existe.` });
      }
      console.error('Erro universidade/curso POST:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

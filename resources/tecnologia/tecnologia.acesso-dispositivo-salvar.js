// POST /tecnologia/acesso-dispositivos — cria/renomeia um controlador Intelbras.
// Body: { id?, nome, local }. Sem id = cria; com id = atualiza nome/local.
// Perm 1034. Auditado.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1034]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/acesso-dispositivos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    const id = b.id ? Number(b.id) : null;
    const nome = trim(b.nome).slice(0, 60);
    const local = trim(b.local).slice(0, 120) || null;
    if (!nome) return res.status(400).json({ message: 'Nome do controlador é obrigatório.' });

    try {
      const dup = await Pg.connectAndQuery(
        `SELECT id FROM tab_acesso_dispositivo WHERE LOWER(nome) = LOWER(@nome) ${id ? 'AND id <> @id' : ''}`,
        id ? { nome, id } : { nome });
      if (dup.length) return res.status(409).json({ message: `Já existe um controlador chamado "${nome}".` });

      let salvoId = id;
      if (id) {
        const r = await Pg.connectAndQuery(
          `UPDATE tab_acesso_dispositivo SET nome = @nome, local = @local WHERE id = @id RETURNING id`,
          { id, nome, local });
        if (!r.length) return res.status(404).json({ message: 'Controlador não encontrado.' });
      } else {
        const r = await Pg.connectAndQuery(`
          INSERT INTO tab_acesso_dispositivo (nome, local, ordem)
          VALUES (@nome, @local, (SELECT COALESCE(MAX(ordem), 0) + 1 FROM tab_acesso_dispositivo))
          RETURNING id`, { nome, local });
        salvoId = r[0].id;
      }
      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'AcessoTags', acao: id ? 'DISPOSITIVO_EDITAR' : 'DISPOSITIVO_CRIAR', severidade: 'INFO', req,
        entidade: 'acesso_dispositivo', entidadeId: String(salvoId),
        descricao: `${id ? 'Editou' : 'Criou'} o controlador "${nome}"${local ? ` (${local})` : ''}`
      });
      return res.json({ ok: true, id: salvoId });
    } catch (err) {
      console.error('tecnologia/acesso-dispositivo-salvar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// POST /universidade/rh/area — cria/edita uma grande área (PRD, MKT, QUA...).
// Body: { id?, codigo, nome, ativo }. Perm 15004/15003.

const { ESCREVER, requirePerm, trim, txt, int, audit } = require('./_rh');

module.exports = (app) => ({
  verb: 'post',
  route: '/rh/area',
  middlewares: [requirePerm(app, ESCREVER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    const id = int(b.id) || null;
    const codigo = trim(b.codigo).toUpperCase();
    const nome = txt(b.nome, 120);
    if (!/^[A-Z0-9]{2,6}$/.test(codigo)) return res.status(400).json({ message: 'Código da área: 2 a 6 letras/números (ex.: PRD).' });
    if (!nome) return res.status(400).json({ message: 'Informe o nome da área.' });
    try {
      let rid = id;
      if (id) {
        const r = await Pg.connectAndQuery(
          `UPDATE tab_uni_area SET codigo = @codigo, nome = @nome, ativo = @ativo WHERE id = @id RETURNING id`,
          { codigo, nome, ativo: b.ativo !== false, id });
        if (!r.length) return res.status(404).json({ message: 'Área não encontrada.' });
      } else {
        const r = await Pg.connectAndQuery(
          `INSERT INTO tab_uni_area (codigo, nome) VALUES (@codigo, @nome) RETURNING id`, { codigo, nome });
        rid = r[0].id;
      }
      await audit(app, req, id ? 'ALTERAR' : 'CRIAR', 'uni_area', rid, `${id ? 'Alterou' : 'Criou'} a área ${codigo} — ${nome}`);
      return res.json({ ok: true, id: rid });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ message: `Já existe a área ${codigo}.` });
      throw err;
    }
  }
});

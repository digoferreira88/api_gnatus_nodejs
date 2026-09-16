// GET /treinamentos/admin/salas?q= — lista salas/recursos do M365 (room mailboxes)
// para o admin escolher o local e já reservar o recurso. Perm 20001.
// Precisa da permissão Application "Place.Read.All". Se não estiver concedida (403),
// devolve disponivel:false para o front cair no campo de texto livre.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([20001, 0]);
const M365 = require('../../services/m365');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/admin/salas',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const q = trim(req.query.q);
    try {
      const salas = await M365.listarSalas(q);
      return res.json({ disponivel: true, salas });
    } catch (err) {
      const status = err?.statusCode || err?.code;
      // 403/Authorization = permissão Place.Read.All não concedida → texto livre no front
      if (status === 403 || status === 401 || /Authorization|Access|forbidden/i.test(err?.message || '')) {
        return res.json({ disponivel: false, salas: [], motivo: 'Permissão Place.Read.All não concedida no app do Azure.' });
      }
      console.error('treinamentos/admin-salas:', err.message);
      return res.json({ disponivel: false, salas: [], motivo: 'Não foi possível listar as salas do M365.' });
    }
  }
});

// POST /fiscal/transmite-token — salva/renova o token do Transmite.
// Body: { token } — aceita o JWT puro OU o "Copy as cURL" colado (extrai o JWT).
// Valida que é um JWT não expirado antes de gravar. Perm 16001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const Transmite = require('../../services/transmite');
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/transmite-token',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const user = (req.user && req.user[0]) || {};
    const por = trim(user.NOME) || trim(user.EMAIL) || `id_${user.ID}`;
    const input = (req.body && (req.body.token || req.body.curl || req.body.valor)) || '';
    if (!trim(input)) return res.status(400).json({ message: 'Cole o token (ou o cURL) do Transmite.' });

    try {
      const status = await Transmite.salvarToken(input, por);
      Auditoria.registrar(app, {
        modulo: 'Fiscal', submodulo: 'TransmiteToken', acao: 'RENOVAR', severidade: 'INFO',
        req, entidade: 'transmite', entidadeId: 'token',
        descricao: `Renovou o token do Transmite (expira ${status.expiraEm || '?'})`
      });
      return res.json({ ok: true, ...status });
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }
  }
});

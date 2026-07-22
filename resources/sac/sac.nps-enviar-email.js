// POST /sac/nps/enviar-email  { id, email? }
// Reenvia o link da pesquisa por E-MAIL (canal secundário do CX), a partir da
// caixa cx@gnatus.com.br, com template branded. `email` é opcional: se vier,
// sobrepõe o e-mail vivo da SA1 do cliente. Perm 6003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6003]);
const nps = require('../../services/npsPosvenda');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/nps/enviar-email',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const b = req.body || {};
    const id = Number(b.id);
    if (!id) return res.status(400).json({ message: 'Convite (id) obrigatório.' });

    try {
      const r = await nps.dispararEmail(app, { conviteId: id, emailOverride: trim(b.email) });
      if (!r.ok) {
        const map = {
          convite_nao_encontrado: 'Convite não encontrado.',
          email_invalido: 'E-mail de destino inválido ou não cadastrado. Informe um e-mail.',
        };
        return res.status(422).json({ ok: false, motivo: r.motivo, email: r.email || '', message: map[r.motivo] || `Falha no envio: ${r.motivo}` });
      }
      return res.json({ ok: true, email: r.email, remetente: nps.SENDER_CX() });
    } catch (err) {
      console.error('sac/nps-enviar-email:', err);
      return res.status(500).json({ message: 'Erro ao enviar e-mail: ' + err.message });
    }
  }
});

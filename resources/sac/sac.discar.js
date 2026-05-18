// Click-to-call no SAC: dispara chamada do ramal do user para o telefone informado.
// Backend chama Sigma /dial — PABX toca o ramal e ao atender disca para o destino.
//
// Body: { telefone, clienteCodigo?, clienteLoja?, clienteNome? }

const trim = (v) => String(v || '').trim();

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6001]);

module.exports = (app) => ({
  verb: 'post',
  route: '/discar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Falemais } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const ramal = trim(user.RAMAL);
    if (!ramal) {
      return res.status(400).json({
        message: 'Seu usuário não tem ramal cadastrado. Solicite ao administrador.',
        code: 'RAMAL_NAO_CADASTRADO'
      });
    }

    const telefone = trim(req.body?.telefone);
    if (!telefone) return res.status(400).json({ message: 'Telefone é obrigatório.' });

    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
    const numeroSan = Falemais.sanitizeNumero(telefone);

    let dialId = null;
    let sucesso = false;
    let erro = null;
    try {
      const r = await Falemais.dial({ ramal, phone: numeroSan });
      dialId = r.id;
      sucesso = true;
    } catch (e) {
      erro = e.message || String(e);
    }

    // Log da tentativa
    try {
      await Pg.connectAndQuery(
        `INSERT INTO tab_sac_discagem
           (id_user, ramal, telefone_destino, cliente_codigo, cliente_loja, cliente_nome, sucesso, dial_id, erro, ip_origem)
         VALUES (@uid, @ramal, @tel, @cod, @loja, @nome, @suc, @dial, @err, @ip)`,
        {
          uid: user.ID, ramal, tel: numeroSan,
          cod: trim(req.body?.clienteCodigo) || null,
          loja: trim(req.body?.clienteLoja) || null,
          nome: trim(req.body?.clienteNome) || null,
          suc: sucesso, dial: dialId, err: erro ? erro.slice(0, 500) : null, ip
        }
      );
    } catch (e) { console.error('Falha ao gravar log discagem:', e.message); }

    if (!sucesso) {
      return res.status(502).json({ ok: false, message: 'Falha ao iniciar chamada: ' + erro });
    }
    return res.json({ ok: true, dialId, ramal, telefone: numeroSan });
  }
});

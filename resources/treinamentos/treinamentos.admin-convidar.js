// POST /treinamentos/admin/treinamento/:id/convidar — registra uma lista de e-mails
// de convidados e dispara o convite (o convidado escolhe a data na intranet).
// Body: { emails: "a@x.com; b@y.com\n..." | string[], mensagem? }
// Perm 20001. Best-effort no envio (nunca falha o cadastro por causa de e-mail).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([20001, 0]);
const Auditoria = require('../../services/auditoria');
const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/admin/treinamento/:id/convidar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id) || 0;
    const b = req.body || {};
    const mensagem = trim(b.mensagem) || null;

    const emails = Treina.parseEmails(b.emails);
    if (!id) return res.status(400).json({ message: 'Treinamento inválido.' });
    if (!emails.length) return res.status(400).json({ message: 'Informe ao menos um e-mail válido.' });
    if (emails.length > 500) return res.status(400).json({ message: 'Limite de 500 convidados por vez.' });

    try {
      const tr = await Pg.connectAndQuery(
        `SELECT id, titulo, objetivo, descricao, instrutor, setor_responsavel, local_padrao,
                teams_link, modalidades, status
           FROM tab_treina_treinamento WHERE id=@id`, { id });
      if (!tr.length) return res.status(404).json({ message: 'Treinamento não encontrado.' });
      const treinamento = tr[0];

      const sessoes = await Pg.connectAndQuery(
        `SELECT id, data, hora_inicio, hora_fim, local, teams_link
           FROM tab_treina_sessao WHERE treinamento_id=@id AND status='agendada'
          ORDER BY data, hora_inicio`, { id });

      const uid = user?.id ? Number(user.id) : null;
      let adicionados = 0, jaExistiam = 0, enviados = 0;
      const falhas = [];

      for (const email of emails) {
        const ins = await Pg.connectAndQuery(
          `INSERT INTO tab_treina_convite (treinamento_id, email, convidado_por, token)
           VALUES (@id, @email, @uid, @token)
           ON CONFLICT (treinamento_id, lower(email)) DO NOTHING
           RETURNING id, token, nome`, { id, email, uid, token: Treina.novoToken() });
        let convite = ins[0];
        if (convite) { adicionados++; }
        else {
          jaExistiam++;
          const ex = await Pg.connectAndQuery(
            `SELECT id, token, nome FROM tab_treina_convite WHERE treinamento_id=@id AND lower(email)=lower(@email)`,
            { id, email });
          convite = ex[0];
        }

        const link = convite?.token ? Treina.linkConvite(convite.token) : undefined;
        const r = await Treina.enviarConvite(app, { treinamento, sessoes, email, nome: convite?.nome, mensagem, link });
        if (r.ok) {
          enviados++;
          await Pg.connectAndQuery(
            `UPDATE tab_treina_convite SET reenviado_em=NOW()
              WHERE treinamento_id=@id AND lower(email)=lower(@email)`, { id, email });
        } else if (!r.skip) {
          falhas.push(email);
        }
      }

      Auditoria.registrar(app, {
        modulo: 'Treinamentos', submodulo: 'Convites', acao: 'CONVIDAR', severidade: 'INFO',
        req, entidade: 'treinamento', entidadeId: String(id),
        descricao: `Convidou ${emails.length} e-mail(s) para "${treinamento.titulo}" (${adicionados} novos, ${enviados} enviados)`,
        meta: { total: emails.length, adicionados, jaExistiam, enviados, falhas: falhas.length }
      });

      return res.json({
        ok: true, total: emails.length, adicionados, jaExistiam, enviados,
        falhas: falhas.length ? falhas : undefined,
        emailAtivo: String(process.env.TREINA_EMAIL_ATIVO || '1') !== '0'
      });
    } catch (err) {
      console.error('treinamentos/admin-convidar:', err.message);
      return res.status(500).json({ message: 'Erro ao convidar: ' + err.message });
    }
  }
});

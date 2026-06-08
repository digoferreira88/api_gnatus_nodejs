const bcrypt = require('bcryptjs');
const Auditoria = require('../../services/auditoria');
const { sendEmail } = require('../../services/emailService');

// URL pública da intranet (link de acesso no e-mail de boas-vindas).
const INTRANET_URL = process.env.INTRANET_URL || process.env.FRONTEND_URL || 'https://intranew.gnatus.com.br';

const escapeHtml = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// E-mail de boas-vindas com login + senha provisória + link de acesso.
function montarEmailBoasVindas({ nome, email, senha, link }) {
  const text =
`Olá, ${nome}!

Seu acesso à Intranet Gnatus foi criado.

Login (e-mail): ${email}
Senha provisória: ${senha}
Acesse em: ${link}

Por segurança, troque sua senha no primeiro acesso pelo menu "Alterar Senha".

Equipe de TI — Gnatus`;

  const html =
`<!doctype html><html><body style="margin:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#1a2740;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <div style="background:#1e5fb5;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0;">
      <h1 style="margin:0;font-size:20px;">Bem-vindo(a) à Intranet Gnatus</h1>
    </div>
    <div style="background:#fff;padding:22px;border-radius:0 0 12px 12px;">
      <p>Olá, <strong>${escapeHtml(nome)}</strong>! Seu acesso à intranet foi criado. Use as credenciais abaixo para entrar:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:15px;">
        <tr><td style="padding:8px 0;color:#6b7a90;">Login</td><td style="padding:8px 0;text-align:right;font-weight:700;">${escapeHtml(email)}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7a90;border-top:1px solid #eef2f8;">Senha provisória</td><td style="padding:8px 0;text-align:right;font-weight:700;border-top:1px solid #eef2f8;font-family:Consolas,monospace;">${escapeHtml(senha)}</td></tr>
      </table>
      <a href="${escapeHtml(link)}" style="display:inline-block;background:#1e7d4f;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;">Acessar a intranet</a>
      <p style="margin-top:18px;font-size:14px;color:#6b7a90;">Por segurança, <strong>troque sua senha no primeiro acesso</strong> pelo menu "Alterar Senha".</p>
      <p style="font-size:13px;color:#8093ac;margin-top:18px;">Se você não esperava este e-mail, avise a TI.</p>
    </div>
  </div>
</body></html>`;
  return { text, html };
}

module.exports = (app) => ({
  verb: 'post',
  route: '/create',
  middlewares: [require('../../middlewares/requirePerm')(app)([1028])],  // 1028 = Gestao Usuarios

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const { nome, email, senha, matricula, ativo, codigoProtheus, ramal, permissoes, enviarEmail } = req.body || {};

    if (!nome || !email || !senha || !matricula) {
      return res.status(400).json({ message: 'Nome, email, senha e matrícula são obrigatórios.' });
    }
    if (String(senha).length < 6) {
      return res.status(400).json({ message: 'A senha precisa ter pelo menos 6 caracteres.' });
    }

    // Valida código Protheus se fornecido — deve existir em SYS_USR
    const codProth = String(codigoProtheus || '').trim();
    if (codProth) {
      try {
        const v = await Protheus.connectAndQuery(
          `SELECT TOP 1 USR_ID FROM SYS_USR WHERE USR_ID = @cod`,
          { cod: codProth }
        );
        if (!v.length) return res.status(400).json({ message: `Código Protheus '${codProth}' não encontrado em SYS_USR.` });
      } catch (e) { console.warn('Não foi possível validar código Protheus:', e.message); }
    }

    try {
      const existente = await Pg.connectAndQuery(
        `SELECT ID, ATIVO FROM tab_intranet_usr WHERE EMAIL = @email`,
        { email }
      );
      if (existente.length > 0) {
        const inativo = !existente[0].ATIVO;
        return res.status(409).json({
          message: inativo
            ? `Já existe usuário com este e-mail (atualmente DESATIVADO). Localize-o na lista e clique em "Ativar".`
            : `Já existe um usuário ativo com este e-mail.`,
          existeId: existente[0].ID,
          existeAtivo: !inativo
        });
      }

      const senhaHash = bcrypt.hashSync(String(senha), 10);
      const ativoFlag = ativo === false ? false : true;

      const ramalTrim = String(ramal || '').trim().slice(0, 8) || null;

      const result = await Pg.connectAndQuery(
        `INSERT INTO tab_intranet_usr (nome, email, senha, matricula, ativo, codigo_protheus, ramal)
         VALUES (@nome, @email, @senha, @matricula, @ativo, @codProth, @ramal)
         RETURNING id`,
        { nome, email, senha: senhaHash, matricula, ativo: ativoFlag, codProth: codProth || null, ramal: ramalTrim }
      );
      const novoId = result[0]?.id;

      // Permissoes opcionais — array de id_permissao (numeros). Insere em batch.
      // Aceita perm 0 (admin universal) tambem. Filtra valores nao-numericos.
      const permsValidas = Array.isArray(permissoes)
        ? permissoes.map(p => Number(p)).filter(n => Number.isInteger(n))
        : [];
      if (novoId && permsValidas.length > 0) {
        const valuesSql = permsValidas.map((_, i) => `(@uid, @p${i})`).join(',');
        const params = { uid: novoId };
        permsValidas.forEach((p, i) => { params[`p${i}`] = p; });
        await Pg.connectAndQuery(
          `INSERT INTO tab_intranet_usr_permissoes (id_user, id_permissao)
           VALUES ${valuesSql}
           ON CONFLICT DO NOTHING`,
          params
        );
      }

      // E-mail de boas-vindas (login + senha provisória + link). BEST-EFFORT:
      // nunca derruba a criação do usuário — se o e-mail falhar, o usuário
      // continua criado e só avisamos. Só envia se o operador pediu E o usuário
      // está ativo (inativo não loga, não faz sentido mandar credencial).
      let emailEnviado = false;
      let emailErro = null;
      if (enviarEmail === true && ativoFlag) {
        try {
          const { text, html } = montarEmailBoasVindas({ nome, email, senha: String(senha), link: INTRANET_URL });
          await sendEmail({ to: email, subject: 'Seu acesso à Intranet Gnatus', text, html });
          emailEnviado = true;
        } catch (e) {
          emailErro = e.message;
          console.warn('users.create: falha ao enviar e-mail de boas-vindas —', e.message);
        }
      }

      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'GestaoUsuarios', acao: 'CREATE', severidade: 'CRITICO',
        req, entidade: 'usuario_intranet', entidadeId: novoId,
        descricao: `Criou usuário "${nome}" (${email})${permsValidas.length ? ` com ${permsValidas.length} permissão(ões)` : ''}${emailEnviado ? ' · e-mail de acesso enviado' : ''}`,
        meta: { nome, email, matricula, codigo_protheus: codProth, permissoes: permsValidas, ativo: ativoFlag, email_enviado: emailEnviado }
      });
      return res.status(201).json({ ok: true, id: novoId, permissoesAplicadas: permsValidas.length, emailEnviado, emailErro });
    } catch (err) {
      console.error('Erro ao criar usuário:', err);
      return res.status(500).json({ message: 'Erro ao criar usuário.' });
    }
  }
});

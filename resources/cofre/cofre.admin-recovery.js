// POST /cofre/admin/recovery
// A TI usa pra recuperar a recovery key de um usuario que perdeu master
// password + chave impressa.
//
// HARDENING:
//   1. Perm 1026 obrigatoria (TI/admin)
//   2. REAUTH — o admin precisa enviar a propria senha no body. Sem isso,
//      JWT roubado de admin = takeover do cofre de qualquer pessoa.
//   3. Justificativa min 30 chars (era 15)
//   4. Notificacao email pra VITIMA (com data, motivo, quem solicitou) —
//      ela sabe que o cofre dela foi aberto, mesmo se nao foi consultada.
//   5. Auditoria CRITICA (ja existia)

const bcrypt = require('bcryptjs');
const backup = require('../../services/cofreBackup');
const Auditoria = require('../../services/auditoria');
const { sendEmail } = require('../../services/emailService');

const JUST_MIN = 30;

module.exports = (app) => ({
  verb: 'post',
  route: '/admin/recovery',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const reqUser = req.user && req.user[0];
    if (!reqUser) return res.status(401).json({ message: 'Usuario nao autenticado.' });

    // Checa perm 1026
    const perm = await Pg.connectAndQuery(
      `SELECT 1 AS ok FROM tab_intranet_usr_permissoes
       WHERE id_user = @id AND id_permissao IN (0, 1026) LIMIT 1`,
      { id: reqUser.ID }
    );
    if (perm.length === 0) {
      return res.status(403).json({ message: 'Acesso restrito a equipe de TI (permissao 1026).' });
    }

    const { email, justificativa, senhaAdmin } = req.body || {};
    if (!email || !justificativa || justificativa.length < JUST_MIN) {
      return res.status(400).json({
        message: `Informe e-mail do usuario alvo e justificativa (min ${JUST_MIN} caracteres).`
      });
    }
    if (!senhaAdmin || String(senhaAdmin).length < 6) {
      return res.status(400).json({ message: 'Senha do admin obrigatoria pra confirmar a operacao.' });
    }

    // Reauth: confere senha do admin requester
    const meRows = await Pg.connectAndQuery(
      `SELECT senha FROM tab_intranet_usr WHERE id = @id AND ativo = true`,
      { id: reqUser.ID }
    );
    if (!meRows.length || !bcrypt.compareSync(String(senhaAdmin), meRows[0].senha)) {
      // Audita TENTATIVA falha — sinal forte de JWT roubado
      Auditoria.registrar(app, {
        modulo: 'Cofre', submodulo: 'AdminRecovery', acao: 'EXECUTE_FAIL', severidade: 'CRITICO',
        req, entidade: 'cofre_recovery_key', entidadeId: null,
        descricao: `Tentativa de admin-recovery com senha incorreta (alvo=${email})`,
        meta: { alvo_email: email }
      });
      return res.status(401).json({ message: 'Senha do admin incorreta.' });
    }

    try {
      // Busca o usuario-alvo
      const alvo = await Pg.connectAndQuery(
        `SELECT id, nome, email FROM tab_intranet_usr
          WHERE LOWER(email) = LOWER(@email) AND ativo = true`,
        { email }
      );
      if (alvo.length === 0) return res.status(404).json({ message: 'Usuario nao encontrado.' });
      const target = alvo[0];

      // Busca o backup
      const meta = await Pg.connectAndQuery(
        `SELECT META_ID, META_DATA, META_HASH, META_READ_COUNT
           FROM tab_sys_audit_meta WHERE META_REF = @ref`,
        { ref: target.id }
      );
      if (meta.length === 0) {
        return res.status(404).json({ message: 'Backup nao encontrado. Usuario pode nao ter cofre configurado.' });
      }

      const recoveryKey = backup.decrypt(meta[0].META_DATA);

      // Incrementa contadores
      await Pg.connectAndQuery(
        `UPDATE tab_sys_audit_meta
            SET META_LAST_READ = NOW(),
                META_READ_COUNT = META_READ_COUNT + 1
          WHERE META_ID = @id`,
        { id: meta[0].META_ID }
      );

      // Notifica a VITIMA por email — assim ela sabe que o cofre dela foi aberto
      // (mesmo se nao foi consulta legitima dela). Async — nao bloqueia a resposta.
      sendEmail({
        to: target.email,
        subject: '[Intranet GNATUS] Sua recovery-key do Cofre foi acessada pela TI',
        text:
`Ola ${target.nome},

A equipe de TI acabou de acessar a chave de recuperacao do seu Cofre de Senhas.

Detalhes:
- Solicitante: ${reqUser.NOME || reqUser.nome} (${reqUser.EMAIL || reqUser.email})
- Data: ${new Date().toLocaleString('pt-BR')}
- Justificativa: ${justificativa}

Se voce NAO solicitou essa recuperacao ou nao reconhece o motivo acima,
responda imediatamente este e-mail e avise a TI por outro canal.

A recuperacao geralmente eh feita quando voce esquece a senha mestre E perde
a chave impressa de backup. Apos isso, voce deve redefinir a senha mestre
o quanto antes.

--
Equipe de Tecnologia GNATUS`
      }).catch(err => console.error('[admin-recovery] falha email vitima:', err.message));

      console.log(`[AUDIT COFRE RECOVERY] ${new Date().toISOString()} | ` +
                  `solicitante: ${reqUser.EMAIL} (id=${reqUser.ID}) | ` +
                  `alvo: ${target.email} (id=${target.id}) | ` +
                  `leitura #${meta[0].META_READ_COUNT + 1}`);

      Auditoria.registrar(app, {
        modulo: 'Cofre', submodulo: 'AdminRecovery', acao: 'EXECUTE', severidade: 'CRITICO',
        req, entidade: 'cofre_recovery_key', entidadeId: target.id,
        descricao: `Recuperou recovery-key de ${target.email}. Justificativa: ${justificativa}`,
        meta: { alvo_id: target.id, alvo_email: target.email, leitura_numero: meta[0].META_READ_COUNT + 1, justificativa }
      });

      return res.json({
        usuario: { id: target.id, nome: target.nome, email: target.email },
        recoveryKey,
        leituraNumero: meta[0].META_READ_COUNT + 1,
        vitimaNotificadaEm: target.email
      });
    } catch (err) {
      console.error('Erro cofre/admin-recovery:', err);
      return res.status(500).json({ message: 'Erro ao recuperar chave.' });
    }
  }
});

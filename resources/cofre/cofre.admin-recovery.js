// Endpoint administrativo: a TI usa pra recuperar a recovery key de um usuário
// que perdeu tanto a master password quanto a chave impressa.
//
// Proteções:
//  1. Exige que o requester tenha permissão 1026 (admin TI).
//  2. Log automático: cada leitura incrementa META_READ_COUNT e atualiza META_LAST_READ.
//  3. Justificativa obrigatória no body (vai pro console.log do servidor).
const backup = require('../../services/cofreBackup');
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'post',
  route: '/admin/recovery',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const reqUser = req.user && req.user[0];
    if (!reqUser) return res.status(401).json({ message: 'Usuário não autenticado.' });

    // Checa se o requester tem permissão admin (1026)
    const perm = await Pg.connectAndQuery(
      `SELECT 1 AS ok FROM tab_intranet_usr_permissoes
       WHERE ID_USER = @id AND ID_PERMISSAO = 1026`,
      { id: reqUser.ID }
    );
    if (perm.length === 0) {
      return res.status(403).json({ message: 'Acesso restrito à equipe de TI (permissão 1026).' });
    }

    const { email, justificativa } = req.body || {};
    if (!email || !justificativa || justificativa.length < 15) {
      return res.status(400).json({ message: 'Informe o e-mail do usuário e uma justificativa (mín 15 caracteres).' });
    }

    try {
      // Busca o usuário-alvo
      const alvo = await Pg.connectAndQuery(
        `SELECT u.ID, u.NOME, u.EMAIL
         FROM tab_intranet_usr u WHERE u.EMAIL = @email AND u.ativo = true`,
        { email }
      );
      if (alvo.length === 0) return res.status(404).json({ message: 'Usuário não encontrado.' });
      const target = alvo[0];

      // Busca o backup
      const meta = await Pg.connectAndQuery(
        `SELECT META_ID, META_DATA, META_HASH, META_READ_COUNT
         FROM tab_sys_audit_meta WHERE META_REF = @ref`,
        { ref: target.ID }
      );
      if (meta.length === 0) {
        return res.status(404).json({ message: 'Backup não encontrado. Usuário pode não ter cofre configurado.' });
      }

      const recoveryKey = backup.decrypt(meta[0].META_DATA);

      // Atualiza contadores de auditoria
      await Pg.connectAndQuery(
        `UPDATE tab_sys_audit_meta
         SET META_LAST_READ = GETDATE(),
             META_READ_COUNT = META_READ_COUNT + 1
         WHERE META_ID = @id`,
        { id: meta[0].META_ID }
      );

      // Log pra console (em produção: canal de auditoria permanente)
      console.log(`[AUDIT COFRE RECOVERY] ${new Date().toISOString()} | ` +
                  `solicitante: ${reqUser.EMAIL} (id=${reqUser.ID}) | ` +
                  `alvo: ${target.EMAIL} (id=${target.ID}) | ` +
                  `leitura #${meta[0].META_READ_COUNT + 1} | ` +
                  `justificativa: ${justificativa}`);

      Auditoria.registrar(app, {
        modulo: 'Cofre', submodulo: 'AdminRecovery', acao: 'EXECUTE', severidade: 'CRITICO',
        req, entidade: 'cofre_recovery_key', entidadeId: target.ID,
        descricao: `Recuperou recovery-key de ${target.EMAIL}. Justificativa: ${justificativa}`,
        meta: { alvo_id: target.ID, alvo_email: target.EMAIL, leitura_numero: meta[0].META_READ_COUNT + 1, justificativa }
      });

      return res.json({
        usuario: { id: target.ID, nome: target.NOME, email: target.EMAIL },
        recoveryKey,
        leituraNumero: meta[0].META_READ_COUNT + 1
      });
    } catch (err) {
      console.error('Erro cofre/admin-recovery:', err);
      return res.status(500).json({ message: 'Erro ao recuperar chave.' });
    }
  }
});

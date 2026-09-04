// POST /fiscal/nfse-recebidas/:chave/conferir   body: { conferida: true|false }
// Marca uma NFS-e recebida como CONFERIDA (escriturada/conferida pelo fiscal) ou
// volta pra PENDENTE. É o "concluir" da fila de pendências. Perm 16001. Auditoria.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'post',
  route: '/nfse-recebidas/:chave/conferir',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const chave = String(req.params.chave || '').replace(/\D/g, '');
    if (chave.length !== 50) return res.status(400).json({ message: 'Chave de NFS-e inválida (esperado 50 dígitos).' });

    const conferida = req.body?.conferida !== false;   // default true
    const situacao = conferida ? 'CONFERIDA' : 'PENDENTE';

    try {
      const upd = await Pg.connectAndQuery(
        `UPDATE tab_nfse_recebida
            SET situacao=@s,
                conferido_por = CASE WHEN @s='CONFERIDA' THEN @uid ELSE NULL END,
                conferido_em  = CASE WHEN @s='CONFERIDA' THEN NOW() ELSE NULL END
          WHERE chave=@c RETURNING chave, numero, emit_nome`,
        { s: situacao, uid: user?.id ? Number(user.id) : null, c: chave });
      if (!upd.length) return res.status(404).json({ message: 'NFS-e não encontrada.' });

      Auditoria.registrar(app, {
        modulo: 'Fiscal', submodulo: 'NFSeRecebidas',
        acao: conferida ? 'CONFERIR' : 'REABRIR', severidade: 'INFO',
        req, entidade: 'nfse', entidadeId: chave,
        descricao: `${conferida ? 'Conferiu' : 'Reabriu'} NFS-e ${upd[0].numero || chave} (${upd[0].emit_nome || ''})`
      });

      return res.json({ ok: true, chave, situacao });
    } catch (err) {
      console.error('fiscal/nfse-recebida-conferir:', err.message);
      return res.status(500).json({ message: 'Erro ao conferir: ' + err.message });
    }
  }
});

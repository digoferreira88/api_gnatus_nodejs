// DELETE /planejamento/reserva/:recno
// Cancela a reserva (soft-delete na SC0010 + devolve o saldo a B2_RESERVA).
// Regra do sistema antigo: só o DONO cancela; admin (perm 0) cancela qualquer uma.
// Perm 3001. Auditoria CRITICO.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([3001]);
const Auditoria = require('../../services/auditoria');
const Reserva = require('../../services/protheusReserva');
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

module.exports = (app) => ({
  verb: 'delete',
  route: '/reserva/:recno',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const recno = Number(req.params.recno);
    if (!Number.isInteger(recno) || recno <= 0) return res.status(400).json({ message: 'recno inválido.' });

    try {
      // admin universal (perm 0) pode cancelar reserva de qualquer pessoa
      const adm = await Pg.connectAndQuery(
        `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @id AND id_permissao = 0 LIMIT 1`,
        { id: user.ID }
      );
      const isAdmin = adm.length > 0;

      const r = await Reserva.cancelar(Protheus, { recno, user, isAdmin });

      if (!r.ok) {
        const msgs = {
          NAO_ENCONTRADA: 'Reserva não encontrada (ou já cancelada).',
          SEM_PERMISSAO: `Somente ${r.dono || 'quem fez a reserva'} pode cancelá-la.`
        };
        const status = r.erro === 'NAO_ENCONTRADA' ? 404 : (r.erro === 'SEM_PERMISSAO' ? 403 : 500);
        return res.status(status).json({ ok: false, message: msgs[r.erro] || (r.msg || 'Erro ao cancelar.'), erro: r.erro });
      }

      Auditoria.registrar(app, {
        modulo: 'Planejamento', submodulo: 'Reserva', acao: 'CANCELAR_RESERVA', severidade: 'CRITICO', req,
        entidade: 'sc0010', entidadeId: String(recno),
        descricao: `Cancelou a reserva ${String(recno).padStart(6, '0')} (dono: ${r.dono})${isAdmin && r.dono !== Reserva.loginDe(user) ? ' [como ADMIN]' : ''}`,
        meta: { recno, dono: r.dono, canceladoPor: Reserva.loginDe(user), isAdmin }
      });

      return res.json({ ok: true, message: 'Reserva cancelada e saldo devolvido ao estoque.' });
    } catch (err) {
      if (ehConexao(err)) return res.status(503).json({ ok: false, message: MSG_INDISPONIVEL, conexao: true });
      console.error('planejamento/reserva cancelar:', err);
      return res.status(500).json({ ok: false, message: 'Erro ao cancelar reserva: ' + err.message });
    }
  }
});

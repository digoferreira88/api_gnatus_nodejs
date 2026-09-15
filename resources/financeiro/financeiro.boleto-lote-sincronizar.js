// POST /financeiro/boleto-lote/:id/sincronizar
//
// Consulta SE1 no Protheus pra cada titulo do lote, le E1_OCORREN/E1_NUMBOR/
// E1_NUMBCO/E1_BAIXA e atualiza tab_boleto_envio_lote_retorno com o status
// banco a banco. Atualiza tambem contadores do lote.
//
// O nucleo da sincronizacao vive em services/boletoSincronizar.js — tambem
// usado pelo boleto-importar-retorno depois de uma baixa pelo .RET.
//
// Pre-condicao: lote em status >= 'ENVIADO_PROTHEUS'.
//
// Permissao 8005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const Auditoria = require('../../services/auditoria');
const BoletoSincronizar = require('../../services/boletoSincronizar');

module.exports = (app) => ({
  verb: 'post',
  route: '/boleto-lote/:id/sincronizar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'id invalido.' });
    }

    try {
      // 1) Carrega lote + valida dono/admin e status
      const cab = await Pg.connectAndQuery(
        `SELECT * FROM tab_boleto_envio_lote WHERE id = @id`, { id }
      );
      if (!cab.length) return res.status(404).json({ message: 'Lote nao encontrado.' });
      const lote = cab[0];

      const isAdmin = await Pg.connectAndQuery(
        `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @uid AND id_permissao = 0 LIMIT 1`,
        { uid: user.ID }
      );
      if (lote.id_user !== user.ID && !isAdmin.length) {
        return res.status(403).json({ message: 'Sem permissao pra sincronizar este lote.' });
      }

      if (!BoletoSincronizar.STATUS_SINCRONIZAVEIS.includes(lote.status)) {
        return res.status(409).json({
          message: `Lote em status "${lote.status}" — sincroniza so depois de "ENVIADO_PROTHEUS".`
        });
      }

      // 2) Sincroniza com a SE1
      const r = await BoletoSincronizar.sincronizarLote({ Pg, Protheus, id });
      if (!r.encontrado) return res.status(404).json({ message: 'Lote nao encontrado.' });
      if (r.semTitulos) return res.status(400).json({ message: 'Lote sem titulos.' });
      const { stats, novoStatus } = r;

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: 'SINCRONIZAR_BANCO', severidade: 'INFO',
        req, entidade: 'boleto_lote', entidadeId: String(id),
        descricao: `Sincronizou status do lote #${id}: ${stats.REGISTRADO} reg, ${stats.LIQUIDADO} liq, ${stats.REJEITADO} rej, ${stats.PENDENTE} pend`,
        meta: { id_lote: id, ...stats, novo_status: novoStatus }
      });

      return res.json({
        ok: true,
        id_lote: id,
        novo_status: novoStatus,
        stats
      });
    } catch (err) {
      console.error('boleto-lote sincronizar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

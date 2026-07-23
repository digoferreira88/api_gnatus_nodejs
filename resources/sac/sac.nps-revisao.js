// POST /sac/nps/revisao  { id, acao: 'enviar' | 'descartar' }
// Decisão do operador sobre um convite travado pela TRAVA SAC (status REVISAO:
// cliente com reclamação aberta no Atendimento ao Consumidor).
//   enviar    -> dispara a pesquisa por WhatsApp assim mesmo (status ENVIADO)
//   descartar -> não pesquisa este cliente (status DESCARTADO)
// Perm 6003. Para reenviar por e-mail em vez de WhatsApp, use /sac/nps/enviar-email.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6003]);
const nps = require('../../services/npsPosvenda');
const Suri = require('../../services/suri');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/nps/revisao',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    const id = Number(b.id);
    const acao = trim(b.acao).toLowerCase();
    if (!id) return res.status(400).json({ message: 'Convite (id) obrigatório.' });
    if (!['enviar', 'descartar'].includes(acao)) return res.status(400).json({ message: "Ação inválida (use 'enviar' ou 'descartar')." });

    try {
      const rows = await Pg.connectAndQuery(
        `SELECT id, token, cliente_nome, telefone, status FROM tab_nps_convite WHERE id=@id`, { id });
      if (!rows.length) return res.status(404).json({ message: 'Convite não encontrado.' });
      const c = rows[0];
      if (trim(c.status) !== 'REVISAO') {
        return res.status(409).json({ message: `Convite não está em revisão (status atual: ${trim(c.status)}).` });
      }

      if (acao === 'descartar') {
        await Pg.connectAndQuery(`UPDATE tab_nps_convite SET status='DESCARTADO' WHERE id=@id`, { id });
        return res.json({ ok: true, status: 'DESCARTADO' });
      }

      // acao === 'enviar' — dispara por WhatsApp (mesmo canal do automático)
      const disp = await nps.dispararWhatsapp({ telefone: c.telefone, nome: trim(c.cliente_nome), token: c.token });
      if (!disp.ok) {
        return res.status(422).json({ ok: false, motivo: disp.motivo,
          message: disp.motivo === 'telefone_invalido'
            ? 'Telefone inválido para WhatsApp. Tente enviar por e-mail.'
            : `Falha no envio: ${disp.motivo}` });
      }
      await Pg.connectAndQuery(
        `UPDATE tab_nps_convite SET status='ENVIADO', telefone=@tel, enviado_em=NOW(), envio_resposta=@r::jsonb WHERE id=@id`,
        { tel: Suri.normalizePhone(c.telefone), r: JSON.stringify(disp.raw || { motivo: disp.motivo }), id });
      return res.json({ ok: true, status: 'ENVIADO' });
    } catch (err) {
      console.error('sac/nps-revisao:', err);
      return res.status(500).json({ message: 'Erro ao processar revisão: ' + err.message });
    }
  }
});

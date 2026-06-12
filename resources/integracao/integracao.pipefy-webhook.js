// POST /integracao/pipefy-webhook?token=<PIPEFY_WH_SECRET>
// Receptor dos webhooks do Pipefy (card.create/move/late dos pipes SAC, Trocas,
// Devolucao, Juridico, Admissao, G-Care, Nao Conformidade). Substitui o
// webhook_gnatus.php da vm-pipefy.
//
// SEM JWT (anonymous): o Pipefy nao envia headers custom, entao o segredo vai
// na querystring. Responde 200 imediatamente e processa async (o Pipefy tem
// timeout curto); resultado fica em tab_pipefy_wh_evento.

const PipefyWebhook = require('../../services/pipefyWebhook');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/pipefy-webhook',
  anonymous: true,

  handler: async (req, res) => {
    const { Pg } = app.services;
    const esperado = trim(process.env.PIPEFY_WH_SECRET);
    if (!esperado) return res.status(503).json({ message: 'PIPEFY_WH_SECRET não configurado.' });
    if (trim(req.query.token) !== esperado) return res.status(401).json({ message: 'Token inválido.' });

    const payload = req.body || {};
    const d = payload.data || {};
    let eventoId = null;
    try {
      const ins = await Pg.connectAndQuery(
        `INSERT INTO tab_pipefy_wh_evento (action, card_id, pipe_id, fase_id, fase_nome, payload)
         VALUES (@a, @c, @p, @f, @fn, @pl::jsonb) RETURNING id`,
        { a: trim(d.action), c: trim(d.card?.id), p: trim(d.card?.pipe_id),
          f: trim(d.to?.id) || trim(d.on_phase?.id) || null, fn: trim(d.to?.name) || null,
          pl: JSON.stringify(payload).slice(0, 100000) });
      eventoId = ins[0]?.id;
    } catch (e) { console.warn('[pipefy-wh] log evento:', e.message); }

    // responde ja (Pipefy nao espera processamento) e processa em background
    res.json({ ok: true, evento: eventoId });

    setImmediate(async () => {
      let resultado;
      try {
        const r = await PipefyWebhook.processarEvento({ Pg }, payload);
        resultado = JSON.stringify(r).slice(0, 1500);
      } catch (e) {
        resultado = 'ERRO: ' + e.message;
        console.error('[pipefy-wh] processar:', e.message);
      }
      if (eventoId) {
        try {
          await Pg.connectAndQuery(
            `UPDATE tab_pipefy_wh_evento SET processado = true, resultado = @r WHERE id = @id`,
            { r: resultado, id: eventoId });
        } catch (e) { console.warn('[pipefy-wh] update evento:', e.message); }
      }
    });
  }
});

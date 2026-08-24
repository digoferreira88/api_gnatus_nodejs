// POST /integracao/datafrete-webhook — receptor do Webhook DataConnect do
// Datafrete (push de ocorrências de transporte). SEM JWT (anonymous): autentica
// pelo header `token` (uuid em DATAFRETE_WEBHOOK_TOKEN no .env) — padrão da doc
// DataConnect ("as credenciais podem ser transmitidas pelo header ou body";
// aceitamos os dois).
//
// Payload esperado (exemplo da doc DataConnect):
//   { event: { type: "order_status", createdAt, data: {
//       nfe: { sender, number, serie, phone }, code, description,
//       observation, processedAt } } }
//
// Evento de ENTREGA (code 1/2, mesmo de-para do GET /ocorrencias) dispara o
// robô da Garantia (services/pipefyGarantia) com DEBOUNCE de 60s — o robô
// re-consulta e move os cards; os gates ATIVO/SIMULAR continuam valendo.
// Sempre responde 2XX rápido quando autenticado (a doc: 3XX/4XX = falha e o
// Datafrete pode re-tentar/desabilitar).

const trim = (v) => String(v == null ? '' : v).trim();

let ultimoDisparo = 0;          // debounce do robô
let executando = false;

module.exports = (app) => ({
  verb: 'post',
  route: '/datafrete-webhook',
  anonymous: true,

  handler: async (req, res) => {
    const { Pg } = app.services;
    const esperado = trim(process.env.DATAFRETE_WEBHOOK_TOKEN);
    const recebido = trim(req.headers['token'] || req.headers['x-api-key'] || req.body?.token);

    if (!esperado) return res.status(503).json({ ok: false, message: 'Webhook não configurado (DATAFRETE_WEBHOOK_TOKEN).' });
    if (recebido !== esperado) {
      console.warn('[datafrete-webhook] token inválido de', req.headers['x-forwarded-for'] || req.ip);
      return res.status(401).json({ ok: false });
    }

    const ev = req.body?.event || {};
    const dados = ev.data || {};
    const nfe = dados.nfe || {};
    const code = trim(dados.code);
    const entrega = code === '1' || code === '2';

    // Log de todo evento recebido (observabilidade do canal push)
    try {
      await Pg.connectAndQuery(`
        INSERT INTO tab_garantia_entrega_log (card_id, card_title, nf, serie_nf, resultado, detalhe, origem)
        VALUES ('WEBHOOK', @titulo, @nf, @serie, @res, @det, 'WEBHOOK')`,
        {
          titulo: trim(ev.type).slice(0, 200) || 'evento',
          nf: trim(nfe.number).slice(0, 20) || null,
          serie: trim(nfe.serie).slice(0, 6) || null,
          res: entrega ? 'WEBHOOK_ENTREGA' : 'WEBHOOK_EVENTO',
          det: `code=${code} ${trim(dados.description)}${trim(dados.observation) ? ` — ${trim(dados.observation)}` : ''}`.slice(0, 500)
        });
    } catch (e) { console.warn('[datafrete-webhook] log falhou:', e.message); }

    // Responde JÁ (Datafrete exige 2XX rápido); o robô roda em background
    res.json({ ok: true, recebido: true });

    if (!entrega) return;
    const agora = Date.now();
    if (executando || (agora - ultimoDisparo) < 60000) return;   // debounce 60s
    ultimoDisparo = agora;
    executando = true;
    try {
      const Garantia = require('../../services/pipefyGarantia');
      if (Garantia.disponivel()) {
        const r = await Garantia.executar(app, 'WEBHOOK');
        if (r.cards > 0) console.log('[datafrete-webhook] robô disparado:', JSON.stringify(r));
      }
    } catch (e) {
      console.error('[datafrete-webhook] robô falhou:', e.message);
    } finally {
      executando = false;
    }
  }
});

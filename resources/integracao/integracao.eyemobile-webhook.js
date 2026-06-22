// POST /integracao/eyemobile-webhook?token=<EYEMOBILE_WH_SECRET>
// Receptor do webhook da EyeMobile (model="transaction"): avisa por e-mail
// (caixa do TI) cada venda efetuada. Rota SEM JWT (anonymous) — a EyeMobile não
// manda header custom, então o segredo vai na querystring. Responde 200 na hora
// e processa/dispara o e-mail em background. Dedupe por id da transação
// (tab_eyemobile_wh) evita e-mail duplicado em reenvios.
//
// .env: EYEMOBILE_WH_SECRET (segredo da URL), EYEMOBILE_NOTIFY_TO (destinatário),
//       EMAIL_SENDER (remetente; default ti@gnatus.com.br).

const emailService = require('../../services/emailService');
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const fmtBRL = (n) => N(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDataHora = (s) => {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : trim(s);
};
// formas de pagamento EyeMobile (type) — fallback p/ rótulo amigável
const PAGTO = { 1: 'Dinheiro', 2: 'Crédito', 3: 'Débito', 4: 'Voucher', 5: 'PIX', 6: 'Outros' };

module.exports = (app) => ({
  verb: 'post',
  route: '/eyemobile-webhook',
  anonymous: true,

  handler: async (req, res) => {
    const { Pg } = app.services;
    const esperado = trim(process.env.EYEMOBILE_WH_SECRET);
    if (!esperado) return res.status(503).json({ message: 'EYEMOBILE_WH_SECRET não configurado.' });
    if (trim(req.query.token) !== esperado && trim(req.headers['x-eyemobile-token']) !== esperado) {
      return res.status(401).json({ message: 'Token inválido.' });
    }

    const payload = req.body || {};
    // a transação pode vir como o corpo inteiro, ou em data/transaction/object
    const trx = payload.transaction || payload.data || payload.object || payload;
    const id = trim(trx.id) || trim(trx.local_id) || trim(payload.id) || `noid-${trim(trx.time)}-${N(trx.total)}`;
    const cancelada = !!(trx.cancelled || trx.cancelada);

    // responde já (a EyeMobile não espera o processamento)
    res.json({ ok: true });

    setImmediate(async () => {
      // dedupe: só segue se for a 1ª vez que vemos esta transação
      let novo = true;
      try {
        const ins = await Pg.connectAndQuery(
          `INSERT INTO tab_eyemobile_wh (id_transacao, total, cancelada, payload)
           VALUES (@id, @t, @c, @p::jsonb)
           ON CONFLICT (id_transacao) DO NOTHING RETURNING id_transacao`,
          { id, t: N(trx.total), c: cancelada, p: JSON.stringify(payload).slice(0, 100000) });
        novo = ins.length > 0;
      } catch (e) { console.warn('[eyemobile-wh] dedupe:', e.message); }
      if (!novo) return;                       // já processado antes
      if (cancelada) return;                    // venda cancelada não notifica "venda efetuada"

      const para = trim(process.env.EYEMOBILE_NOTIFY_TO);
      if (!para) { console.warn('[eyemobile-wh] EYEMOBILE_NOTIFY_TO não configurado.'); return; }

      // monta o e-mail
      const ponto = trim(trx.point && (trx.point.name || trx.point.label));
      const evento = trim(trx.event && (trx.event.name || trx.event.label));
      const operador = trim(trx.user && (trx.user.name || trx.user.username));
      const cliente = trim(trx.customer && (trx.customer.name || trx.customer.full_name)) || trim(trx.customer_doc);
      const pays = Array.isArray(trx.transaction_pays) ? trx.transaction_pays : [];
      const formas = pays.map(p => PAGTO[Number(p.type)] || trim(p.name) || `tipo ${trim(p.type)}`).filter(Boolean);
      const nItens = Array.isArray(trx.transaction_items) ? trx.transaction_items.length : null;
      const docNum = [trim(trx.number), trim(trx.serie)].filter(Boolean).join('/');

      const linhas = [
        ['Valor total', fmtBRL(trx.total)],
        ['Data/hora', fmtDataHora(trx.time || trx.created_at)],
        ponto && ['Ponto de venda', ponto],
        evento && ['Evento', evento],
        formas.length && ['Pagamento', formas.join(', ')],
        nItens != null && ['Itens', String(nItens)],
        cliente && ['Cliente', cliente],
        operador && ['Operador', operador],
        docNum && ['Doc (nº/série)', docNum],
        ['ID transação', id]
      ].filter(Boolean);

      const html = `
        <div style="font-family:Segoe UI,Arial,sans-serif;color:#1a2740">
          <h2 style="color:#1e5fb5;margin:0 0 4px">🛒 Nova venda — EyeMobile</h2>
          <div style="font-size:1.6rem;font-weight:800;color:#1e7d4f;margin:6px 0 12px">${fmtBRL(trx.total)}</div>
          <table style="border-collapse:collapse;font-size:14px">
            ${linhas.map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#8093ac">${k}</td><td style="padding:3px 0;font-weight:600">${v}</td></tr>`).join('')}
          </table>
          <p style="color:#8093ac;font-size:12px;margin-top:14px">Notificação automática da intranet · EyeMobile</p>
        </div>`;
      const text = `Nova venda EyeMobile\n` + linhas.map(([k, v]) => `${k}: ${v}`).join('\n');

      try {
        await emailService.sendEmail({
          to: para,
          subject: `🛒 Nova venda EyeMobile — ${fmtBRL(trx.total)}${ponto ? ' · ' + ponto : ''}`,
          text, html
        });
        await Pg.connectAndQuery(`UPDATE tab_eyemobile_wh SET email_enviado=true WHERE id_transacao=@id`, { id });
      } catch (e) {
        console.error('[eyemobile-wh] email:', e.message);
        try { await Pg.connectAndQuery(`UPDATE tab_eyemobile_wh SET email_erro=@e WHERE id_transacao=@id`, { e: String(e.message).slice(0, 400), id }); } catch (_) { /* */ }
      }
    });
  }
});

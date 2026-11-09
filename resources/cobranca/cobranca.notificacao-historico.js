// GET /cobranca/notificacao-historico?tipo=PROTESTO&dias=30 — o que foi enviado
// (título × canal), com quem enviou, destino e resultado. Perm 9009.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9009]);
const Notif = require('../../services/cobrancaNotificacao');

module.exports = (app) => ({
  verb: 'get',
  route: '/notificacao-historico',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const cfg = Notif.tipoCfg(req.query.tipo || 'PROTESTO');
    if (!cfg) return res.status(400).json({ message: 'Tipo de notificação inválido.' });
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 365);

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT n.id, n.canal, to_char(n.dia, 'YYYY-MM-DD') AS dia, n.prefixo, n.numero, n.parcela, n.tipo_titulo,
               n.cliente_cod, n.cliente_loja, n.cliente_nome, n.valor,
               to_char(n.vencimento, 'YYYYMMDD') AS vencimento, n.dias_atraso,
               n.banco, n.destino, n.status, n.erro, n.envio_id, n.criado_em,
               u.nome AS user_nome
          FROM tab_cobranca_notificacao n
          LEFT JOIN tab_intranet_usr u ON u.id = n.id_user
         WHERE n.tipo = @tipo
           AND n.criado_em >= NOW() - (@dias::int * INTERVAL '1 day')
         ORDER BY n.criado_em DESC, n.cliente_nome, n.numero, n.parcela, n.canal
         LIMIT 2000`, { tipo: cfg.tipo, dias });

      return res.json({
        tipo: cfg.tipo,
        dias,
        envios: rows.map(r => ({
          id: r.id, canal: r.canal, dia: r.dia,
          titulo: `${String(r.numero || '').trim()}${String(r.parcela || '').trim() ? '/' + String(r.parcela).trim() : ''}`,
          cliente_cod: r.cliente_cod, cliente_loja: r.cliente_loja, cliente_nome: r.cliente_nome,
          valor: Number(r.valor || 0), vencimento: r.vencimento, dias_atraso: r.dias_atraso,
          banco: r.banco, destino: r.destino, status: r.status, erro: r.erro,
          envio_id: r.envio_id, criado_em: r.criado_em, usuario: r.user_nome || null
        }))
      });
    } catch (err) {
      console.error('cobranca/notificacao-historico:', err);
      return res.status(500).json({ message: 'Erro ao ler o histórico: ' + err.message });
    }
  }
});

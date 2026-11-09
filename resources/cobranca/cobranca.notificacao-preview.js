// POST /cobranca/notificacao-preview — mostra EXATAMENTE o que o cliente vai
// receber (e-mail renderizado + texto de cada WhatsApp), sem enviar nada.
// Body: { tipo, titulos: [{ prefixo, numero, parcela, tipo, cliente_cod, cliente_loja, banco? }] }
// Os títulos devem ser de UM cliente (a tela pede a prévia por cliente).
// Perm 9009.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9009]);
const Notif = require('../../services/cobrancaNotificacao');

module.exports = (app) => ({
  verb: 'post',
  route: '/notificacao-preview',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const cfg = Notif.tipoCfg(req.body?.tipo || 'PROTESTO');
    if (!cfg) return res.status(400).json({ message: 'Tipo de notificação inválido.' });
    const titulos = Array.isArray(req.body?.titulos) ? req.body.titulos.slice(0, 60) : [];
    if (!titulos.length) return res.status(400).json({ message: 'Informe ao menos 1 título.' });

    try {
      const { pacotes, ignorados } = await Notif.carregarPacotes(app.services, cfg.tipo, titulos);
      const pac = pacotes[0];
      if (!pac) {
        return res.status(404).json({ message: 'Os títulos não estão mais em aberto e vencidos no Protheus.', ignorados });
      }
      const email = Notif.montarEmail({ tipo: cfg.tipo, cliente: pac.cliente, titulos: pac.titulos, outros: pac.outros });
      const whatsapp = pac.titulos.map(t => {
        const params = Notif.parametrosWhatsapp(t, pac.cliente);
        return { titulo: Notif.numTitulo(t), banco: t.banco, texto: Notif.textoWhatsapp(cfg.tipo, params) };
      });
      return res.json({
        tipo: cfg.tipo,
        cliente: { cod: pac.cliente.cod, loja: pac.cliente.loja, nome: pac.cliente.nome },
        email: { para: pac.cliente.emails, assunto: email.assunto, html: email.html },
        telefone: pac.cliente.telefone,
        whatsapp,
        outros: pac.outros.map(Notif.numTitulo),
        ignorados,
        clientes_no_pedido: pacotes.length
      });
    } catch (err) {
      console.error('cobranca/notificacao-preview:', err);
      return res.status(500).json({ message: 'Erro ao montar a prévia: ' + err.message });
    }
  }
});

// GET /expedicao/publico/:token  (ANÔNIMO — link enviado ao cliente por WhatsApp)
// Valida o token e devolve o estado do aviso + 1º nome e nº do pedido. Não expõe
// dados sensíveis. Estados: ABERTO | RESPONDIDO | EXPIRADO | INVALIDO.

const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/publico/:token',
  anonymous: true,

  handler: async (req, res) => {
    const { Pg } = app.services;
    const token = trim(req.params.token);
    if (!token || token.length < 10) return res.status(400).json({ estado: 'INVALIDO', message: 'Link inválido.' });

    try {
      const rows = await Pg.connectAndQuery(
        `SELECT cliente_nome, pedido, status, resposta, expira_em
           FROM tab_expedicao_aviso WHERE token = @t`, { t: token });
      if (!rows.length) return res.status(404).json({ estado: 'INVALIDO', message: 'Aviso não encontrado.' });
      const c = rows[0];

      if (trim(c.resposta)) return res.json({ estado: 'RESPONDIDO', resposta: trim(c.resposta) });
      if (c.expira_em && new Date(c.expira_em) < new Date()) return res.json({ estado: 'EXPIRADO' });

      const primeiroNome = trim(c.cliente_nome).split(/\s+/)[0] || '';
      return res.json({ estado: 'ABERTO', cliente: primeiroNome, pedido: trim(c.pedido) });
    } catch (err) {
      console.error('expedicao/publico-get:', err);
      return res.status(500).json({ message: 'Erro ao carregar o aviso.' });
    }
  }
});

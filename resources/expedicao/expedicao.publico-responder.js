// POST /expedicao/publico/:token  (ANÔNIMO)
// Body: { resposta: 'CONFIRMADO'|'RECUSADO'|'REAGENDAR', novaData?: 'YYYY-MM-DD', observacao?: string }
// Registra a resposta do cliente e fecha o aviso. Idempotente (já respondido → devolve o estado).

const trim = (v) => String(v == null ? '' : v).trim();
const RESPOSTAS = ['CONFIRMADO', 'RECUSADO', 'REAGENDAR'];

module.exports = (app) => ({
  verb: 'post',
  route: '/publico/:token',
  anonymous: true,

  handler: async (req, res) => {
    const { Pg } = app.services;
    const token = trim(req.params.token);
    const resposta = trim(req.body && req.body.resposta).toUpperCase();
    const novaData = trim(req.body && req.body.novaData);
    const observacao = trim(req.body && req.body.observacao).slice(0, 2000);

    if (!token) return res.status(400).json({ message: 'Link inválido.' });
    if (!RESPOSTAS.includes(resposta)) return res.status(400).json({ message: 'Resposta inválida.' });
    if (resposta === 'REAGENDAR' && !/^\d{4}-\d{2}-\d{2}$/.test(novaData)) {
      return res.status(400).json({ message: 'Informe a nova data desejada para o reagendamento.' });
    }

    try {
      const rows = await Pg.connectAndQuery(
        `SELECT id, resposta, expira_em FROM tab_expedicao_aviso WHERE token = @t`, { t: token });
      if (!rows.length) return res.status(404).json({ message: 'Aviso não encontrado.' });
      const c = rows[0];
      if (trim(c.resposta)) return res.json({ estado: 'RESPONDIDO', resposta: trim(c.resposta) });
      if (c.expira_em && new Date(c.expira_em) < new Date()) return res.status(410).json({ estado: 'EXPIRADO', message: 'Este link expirou.' });

      await Pg.connectAndQuery(
        `UPDATE tab_expedicao_aviso
            SET resposta = @resp, nova_data = @nd::date, observacao = @obs,
                respondido_em = NOW(), status = 'RESPONDIDO'
          WHERE id = @id`,
        { resp: resposta, nd: (resposta === 'REAGENDAR' ? novaData : null), obs: observacao || null, id: c.id });

      return res.json({ estado: 'OBRIGADO', resposta });
    } catch (err) {
      console.error('expedicao/publico-responder:', err);
      return res.status(500).json({ message: 'Erro ao registrar sua resposta.' });
    }
  }
});

// GET /expedicao/avisos — lista os avisos de recebimento p/ a expedição acompanhar.
// Params: dias (default 30), apenasAbertos (1 = só impedimentos não tratados).
// Ordena impedimentos abertos primeiro. Perm 12003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([12003, 0]);

module.exports = (app) => ({
  verb: 'get',
  route: '/avisos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 365);
    const apenasAbertos = /^(1|true|sim)$/i.test(String(req.query.apenasAbertos || ''));

    try {
      const cond = [`criado_em >= NOW() - (@dias || ' days')::interval`];
      if (apenasAbertos) cond.push(`resposta IN ('RECUSADO','REAGENDAR') AND tratado = FALSE`);

      const rows = await Pg.connectAndQuery(`
        SELECT id, pedido, cliente_cod, cliente_loja, cliente_nome, telefone,
               bu_nome, vendedor_nome, valor_pedido,
               status, canal, criado_em, enviado_em, expira_em,
               resposta, nova_data, observacao, respondido_em,
               tratado, tratado_em, tratado_obs
          FROM tab_expedicao_aviso
         WHERE ${cond.join(' AND ')}
         ORDER BY (resposta IN ('RECUSADO','REAGENDAR') AND tratado = FALSE) DESC,
                  respondido_em DESC NULLS LAST, criado_em DESC
         LIMIT 1000`, { dias: String(dias) });

      const impedimento = (r) => r.resposta === 'RECUSADO' || r.resposta === 'REAGENDAR';
      const resumo = {
        total: rows.length,
        enviados: rows.filter(r => r.status === 'ENVIADO' || r.status === 'RESPONDIDO').length,
        respondidos: rows.filter(r => r.resposta).length,
        confirmados: rows.filter(r => r.resposta === 'CONFIRMADO').length,
        impedimentos: rows.filter(impedimento).length,
        abertos: rows.filter(r => impedimento(r) && !r.tratado).length,
        semResposta: rows.filter(r => !r.resposta && r.status === 'ENVIADO').length
      };
      return res.json({ avisos: rows, resumo, geradoEm: new Date().toISOString() });
    } catch (err) {
      console.error('expedicao/avisos:', err);
      return res.status(500).json({ message: 'Erro ao listar os avisos.' });
    }
  }
});

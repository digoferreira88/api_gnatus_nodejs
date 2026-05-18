// Upsert de atribuicao manual de carteira por cliente (NORMAL/JURIDICO/NEGOCIACAO).
// Equipe agora deriva do BU (tab_cobranca_bu_equipe) — nao fica mais aqui.
//
// Body: { clienteCod, clienteLoja, carteira?, observacao? }
// Se uma das chaves nao for enviada, o valor anterior eh preservado (COALESCE).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002]);

module.exports = (app) => ({
  verb: 'post',
  route: '/atribuicao',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const { clienteCod, clienteLoja, carteira, observacao } = req.body || {};
    if (!clienteCod || !clienteLoja) {
      return res.status(400).json({ message: 'clienteCod e clienteLoja são obrigatórios.' });
    }

    const carteiraNorm = carteira != null ? String(carteira).trim().toUpperCase() : null;
    const obsNorm      = observacao != null ? String(observacao) : null;

    try {
      const r = await Pg.connectAndQuery(
        `INSERT INTO tab_cobranca_atribuicao
           (cliente_cod, cliente_loja, carteira, observacao, atualizado_por, atualizado_em)
         VALUES (@cod, @loja, @carteira, @obs, @uid, NOW())
         ON CONFLICT (cliente_cod, cliente_loja) DO UPDATE SET
           carteira = COALESCE(EXCLUDED.carteira, tab_cobranca_atribuicao.carteira),
           observacao = COALESCE(EXCLUDED.observacao, tab_cobranca_atribuicao.observacao),
           atualizado_por = EXCLUDED.atualizado_por,
           atualizado_em  = NOW()
         RETURNING id, carteira, observacao, atualizado_em`,
        {
          cod: String(clienteCod).trim(),
          loja: String(clienteLoja).trim(),
          carteira: carteiraNorm,
          obs: obsNorm,
          uid: user.ID
        }
      );

      return res.status(200).json({ ok: true, atribuicao: r[0] });
    } catch (err) {
      console.error('Erro cobranca/atribuicao:', err);
      return res.status(500).json({ message: 'Erro ao gravar atribuição.' });
    }
  }
});

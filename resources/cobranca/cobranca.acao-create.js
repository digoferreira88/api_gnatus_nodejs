// Registra uma nova ação de cobrança (ligação, e-mail, acordo, etc.)
const TIPOS_ACAO = ['LIGACAO','EMAIL','WHATSAPP','VISITA','ACORDO','BAIXA_PARCIAL','OUTRO'];
const RESULTADOS = ['SEM_CONTATO','PROMESSA_PAGAMENTO','RECUSA','PAGO','ACORDO_FECHADO','OUTRO'];

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002]);

module.exports = (app) => ({
  verb: 'post',
  route: '/acao',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const {
      clienteCod, clienteLoja,
      tituloPrefixo, tituloNum, tituloParcela, tituloTipo,
      tipoAcao, resultado, dataPromessa, valorPrometido, descricao
    } = req.body || {};

    if (!clienteCod || !clienteLoja) return res.status(400).json({ message: 'Cliente é obrigatório.' });
    if (!TIPOS_ACAO.includes(tipoAcao)) return res.status(400).json({ message: 'Tipo de ação inválido.' });
    if (!RESULTADOS.includes(resultado)) return res.status(400).json({ message: 'Resultado inválido.' });

    try {
      const result = await Pg.connectAndQuery(
        `INSERT INTO tab_cobranca_acao
           (cliente_cod, cliente_loja, titulo_prefixo, titulo_num, titulo_parcela, titulo_tipo,
            tipo_acao, resultado, data_promessa, valor_prometido, descricao, id_user)
         VALUES (@cod, @loja, @pref, @num, @parc, @tt, @tipo, @res, @dp, @vp, @desc, @uid)
         RETURNING id`,
        {
          cod: String(clienteCod).trim(), loja: String(clienteLoja).trim(),
          pref: String(tituloPrefixo || '').trim(), num: String(tituloNum || '').trim(),
          parc: String(tituloParcela || '').trim(), tt: String(tituloTipo || '').trim(),
          tipo: tipoAcao, res: resultado,
          dp: dataPromessa ? new Date(dataPromessa) : null,
          vp: valorPrometido != null ? Number(valorPrometido) : null,
          desc: descricao || null,
          uid: user.ID
        }
      );
      return res.status(201).json({ ok: true, id: result[0]?.id });
    } catch (err) {
      console.error('Erro cobranca/acao-create:', err);
      return res.status(500).json({ message: 'Erro ao registrar ação.' });
    }
  }
});

// Atualiza o status de cobrança de um cliente (upsert)
const STATUS_VALIDOS = [
  'REGULAR', 'NEGOCIANDO', 'PROMESSA',
  'ACORDO_EM_ANDAMENTO', 'ACORDO_QUEBRADO',
  'RETENCAO', 'DISTRATO', 'DEVOLUCAO',
  'AJUSTE_INTERNO', 'SEM_RETORNO',
  'PROTESTO', 'JURIDICO', 'TERCEIRIZADA', 'NEGATIVADO', 'PERDA'
];

module.exports = (app) => ({
  verb: 'put',
  route: '/status/:cod/:loja',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const cod  = String(req.params.cod  || '').trim();
    const loja = String(req.params.loja || '').trim();
    const { status, observacao } = req.body || {};

    if (!cod || !loja) return res.status(400).json({ message: 'Cliente é obrigatório.' });
    if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ message: 'Status inválido.' });

    try {
      await Pg.connectAndQuery(
        `INSERT INTO tab_cobranca_status_cliente (cliente_cod, cliente_loja, status, observacao, id_user)
         VALUES (@cod, @loja, @status, @obs, @uid)
         ON CONFLICT (cliente_cod, cliente_loja) DO UPDATE
            SET status         = EXCLUDED.status,
                observacao     = EXCLUDED.observacao,
                dt_atualizacao = NOW(),
                id_user        = EXCLUDED.id_user`,
        { cod, loja, status, obs: observacao || null, uid: user.ID }
      );
      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro cobranca/status:', err);
      return res.status(500).json({ message: 'Erro ao atualizar status.' });
    }
  }
});

// Atualiza o status de cobrança de UM TÍTULO (upsert). Status vazio limpa o
// registro e o título volta a herdar o status do cliente. Perm 9001/9002.
const { STATUS_SET } = require('../../services/cobrancaStatus');
const trim = (v) => String(v == null ? '' : v).trim();

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002]);

module.exports = (app) => ({
  verb: 'put',
  route: '/status-titulo/:cod/:loja',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const cod  = trim(req.params.cod);
    const loja = trim(req.params.loja);
    if (!cod || !loja) return res.status(400).json({ message: 'Cliente é obrigatório.' });

    const b = req.body || {};
    const prefixo = trim(b.prefixo);
    const numero  = trim(b.numero);
    const parcela = trim(b.parcela);
    const tipo    = trim(b.tipo);
    const status  = trim(b.status);
    const obs     = trim(b.observacao) || null;

    if (!numero) return res.status(400).json({ message: 'Título é obrigatório.' });

    const key = { cod, loja, prefixo, numero, parcela, tipo };

    try {
      // Status vazio = remover (título volta a herdar o do cliente)
      if (!status) {
        await Pg.connectAndQuery(
          `DELETE FROM tab_cobranca_status_titulo
            WHERE cliente_cod=@cod AND cliente_loja=@loja
              AND titulo_prefixo=@prefixo AND titulo_num=@numero
              AND titulo_parcela=@parcela AND titulo_tipo=@tipo`, key);
        return res.json({ ok: true, cleared: true });
      }

      if (!STATUS_SET.has(status)) return res.status(400).json({ message: 'Status inválido.' });

      await Pg.connectAndQuery(
        `INSERT INTO tab_cobranca_status_titulo
           (cliente_cod, cliente_loja, titulo_prefixo, titulo_num, titulo_parcela, titulo_tipo, status, observacao, id_user)
         VALUES (@cod, @loja, @prefixo, @numero, @parcela, @tipo, @status, @obs, @uid)
         ON CONFLICT (cliente_cod, cliente_loja, titulo_prefixo, titulo_num, titulo_parcela, titulo_tipo) DO UPDATE
            SET status         = EXCLUDED.status,
                observacao     = EXCLUDED.observacao,
                dt_atualizacao = NOW(),
                id_user        = EXCLUDED.id_user`,
        { ...key, status, obs, uid: user.ID });
      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro cobranca/status-titulo:', err);
      return res.status(500).json({ message: 'Erro ao atualizar status do título.' });
    }
  }
});

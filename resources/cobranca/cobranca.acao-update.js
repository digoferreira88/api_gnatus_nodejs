// Edita uma ação de cobrança já registrada (apenas autor ou admin pode editar)
const TIPOS_ACAO = ['LIGACAO','EMAIL','WHATSAPP','VISITA','ACORDO','BAIXA_PARCIAL','OUTRO'];
const RESULTADOS = ['SEM_CONTATO','PROMESSA_PAGAMENTO','RECUSA','PAGO','ACORDO_FECHADO','OUTRO'];

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002]);

module.exports = (app) => ({
  verb: 'put',
  route: '/acao/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: 'ID inválido.' });

    const { tipoAcao, resultado, dataPromessa, valorPrometido, descricao } = req.body || {};
    if (!TIPOS_ACAO.includes(tipoAcao)) return res.status(400).json({ message: 'Tipo de ação inválido.' });
    if (!RESULTADOS.includes(resultado)) return res.status(400).json({ message: 'Resultado inválido.' });

    try {
      const existing = await Pg.connectAndQuery(
        `SELECT ID_USER FROM tab_cobranca_acao WHERE ID = @id`, { id }
      );
      if (!existing.length) return res.status(404).json({ message: 'Ação não encontrada.' });
      if (existing[0].ID_USER !== user.ID && user.EMAIL !== 'admin@gnatus.com.br') {
        return res.status(403).json({ message: 'Sem permissão para editar esta ação.' });
      }

      await Pg.connectAndQuery(
        `UPDATE tab_cobranca_acao
            SET TIPO_ACAO = @tipo, RESULTADO = @res,
                DATA_PROMESSA = @dp, VALOR_PROMETIDO = @vp,
                DESCRICAO = @desc
          WHERE ID = @id`,
        {
          id, tipo: tipoAcao, res: resultado,
          dp: dataPromessa ? new Date(dataPromessa) : null,
          vp: valorPrometido != null ? Number(valorPrometido) : null,
          desc: descricao || null
        }
      );
      return res.json({ ok: true });
    } catch (err) {
      console.error('Erro cobranca/acao-update:', err);
      return res.status(500).json({ message: 'Erro ao atualizar ação.' });
    }
  }
});

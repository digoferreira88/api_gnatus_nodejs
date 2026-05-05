// PUT /controladoria/pt/envios/:id — atualiza cabecalho do envio.
// Aceita qualquer subconjunto dos campos; nao-presentes ficam inalterados.
// Itens nao sao alterados aqui (use endpoint dedicado se necessario).
// Permissao 11003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11003]);

const CAMPOS = [
  'destinatario_nome','destinatario_cod','destinatario_loja',
  'pedido_protheus','solicitante_nome','responsavel_nome',
  'finalidade','natureza_operacao','contrato_comodato',
  'prazo_dias','ultima_validacao_em',
  'data_emissao_nf','data_expedicao','data_vencimento',
  'nf_saida','serie_saida','cfop_saida','valor',
  'observacao','cobranca_1a','cobranca_2a','status'
];

module.exports = (app) => ({
  verb: 'put',
  route: '/pt/envios/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    const b = req.body || {};

    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });

    const sets = [];
    const params = { id, uid: user.ID };
    for (const c of CAMPOS) {
      if (c in b) {
        sets.push(`${c} = @${c}`);
        params[c] = b[c] === '' ? null : b[c];
      }
    }
    if (!sets.length) return res.status(400).json({ message: 'Nenhum campo pra atualizar.' });

    sets.push(`atualizado_por = @uid`);
    sets.push(`atualizado_em = NOW()`);
    // Marca ultima validacao se o operador clicou "marcar como validado"
    if (b.marcar_validado === true) {
      sets.push(`ultima_validacao_em = NOW()`);
      sets.push(`ultima_validacao_por = @uid`);
    }

    try {
      await Pg.connectAndQuery(`UPDATE tab_pt_envio SET ${sets.join(', ')} WHERE id = @id`, params);
      return res.json({ ok: true });
    } catch (err) {
      console.error('pt-update:', err);
      return res.status(500).json({ message: 'Erro ao atualizar: ' + err.message });
    }
  }
});

// POST /controladoria/pt/envios/:id/finalizar — registra finalizacao
// (RETORNO/PARCIAL/VENDA/RENOVACAO/TROCA) e atualiza o status do envio.
// Body: { forma, data_finalizacao, nf_final?, serie_final?, cfop_final?,
//         pedido_venda?, valor_venda?, equipamento_chegou?, observacao? }
// Permissao 11003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11003]);

const trim = (v) => v == null ? null : String(v).trim() || null;
const FORMAS_VALIDAS = ['RETORNO','PARCIAL','VENDA','RENOVACAO','TROCA'];

module.exports = (app) => ({
  verb: 'post',
  route: '/pt/envios/:id/finalizar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    const b = req.body || {};

    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });

    const forma = String(b.forma || '').toUpperCase();
    if (!FORMAS_VALIDAS.includes(forma)) {
      return res.status(400).json({ message: `forma invalida (use ${FORMAS_VALIDAS.join('/')})` });
    }
    if (!b.data_finalizacao) return res.status(400).json({ message: 'data_finalizacao obrigatoria.' });

    try {
      // Verifica se o envio existe
      const env = await Pg.connectAndQuery(`SELECT id FROM tab_pt_envio WHERE id = @id`, { id });
      if (!env.length) return res.status(404).json({ message: 'Envio nao encontrado.' });

      // Insere finalizacao
      await Pg.connectAndQuery(`
        INSERT INTO tab_pt_finalizacao
          (envio_id, forma, data_finalizacao, nf_final, serie_final, cfop_final,
           pedido_venda, valor_venda, equipamento_chegou, observacao, registrado_por)
        VALUES
          (@id, @forma, @data::date, @nf, @serie, @cfop,
           @pedv, @valor, @cheg, @obs, @uid)`,
        {
          id, forma,
          data: b.data_finalizacao,
          nf: trim(b.nf_final), serie: trim(b.serie_final), cfop: trim(b.cfop_final),
          pedv: trim(b.pedido_venda),
          valor: b.valor_venda == null || b.valor_venda === '' ? null : Number(b.valor_venda),
          cheg: b.equipamento_chegou == null ? null : (b.equipamento_chegou === true || b.equipamento_chegou === 'sim'),
          obs: trim(b.observacao),
          uid: user.ID
        }
      );

      // Atualiza status do envio:
      //   PARCIAL → fica PARCIAL
      //   RETORNO/VENDA/RENOVACAO/TROCA → FINALIZADO
      const novoStatus = forma === 'PARCIAL' ? 'PARCIAL' : 'FINALIZADO';
      await Pg.connectAndQuery(
        `UPDATE tab_pt_envio SET status = @s, atualizado_em = NOW(), atualizado_por = @uid WHERE id = @id`,
        { id, s: novoStatus, uid: user.ID }
      );

      return res.json({ ok: true, novo_status: novoStatus });
    } catch (err) {
      console.error('pt-finalizar:', err);
      return res.status(500).json({ message: 'Erro ao finalizar: ' + err.message });
    }
  }
});

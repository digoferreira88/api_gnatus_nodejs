// POST /controladoria/pt/envios — cria envio (com itens opcionais).
// Body: cabecalho do envio + itens[] opcional.
// Permissao 11003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11003]);

const trim = (v) => v == null ? null : String(v).trim() || null;
const toBool = (v) => v === true || v === 'true' || v === 'sim' || v === 'SIM';

module.exports = (app) => ({
  verb: 'post',
  route: '/pt/envios',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};

    if (!trim(b.destinatario_nome)) {
      return res.status(400).json({ message: 'destinatario_nome obrigatorio.' });
    }

    try {
      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_pt_envio (
          destinatario_nome, destinatario_cod, destinatario_loja,
          pedido_protheus, solicitante_nome, responsavel_nome,
          finalidade, natureza_operacao, contrato_comodato,
          prazo_dias, ultima_validacao_em, ultima_validacao_por,
          data_emissao_nf, data_expedicao, data_vencimento,
          nf_saida, serie_saida, cfop_saida, valor,
          observacao, cobranca_1a, cobranca_2a,
          criado_por, atualizado_por, origem
        ) VALUES (
          @destinatario_nome, @destinatario_cod, @destinatario_loja,
          @pedido_protheus, @solicitante_nome, @responsavel_nome,
          @finalidade, @natureza_operacao, @contrato_comodato,
          @prazo_dias, @ultima_validacao_em, @uid,
          @data_emissao_nf::date, @data_expedicao::date, @data_vencimento::date,
          @nf_saida, @serie_saida, @cfop_saida, @valor,
          @observacao, @cobranca_1a, @cobranca_2a,
          @uid, @uid, COALESCE(@origem, 'manual')
        ) RETURNING id`,
        {
          destinatario_nome: trim(b.destinatario_nome),
          destinatario_cod: trim(b.destinatario_cod),
          destinatario_loja: trim(b.destinatario_loja),
          pedido_protheus: trim(b.pedido_protheus),
          solicitante_nome: trim(b.solicitante_nome),
          responsavel_nome: trim(b.responsavel_nome),
          finalidade: trim(b.finalidade),
          natureza_operacao: trim(b.natureza_operacao),
          contrato_comodato: b.contrato_comodato == null ? null : toBool(b.contrato_comodato),
          prazo_dias: b.prazo_dias == null || b.prazo_dias === '' ? null : Number(b.prazo_dias),
          ultima_validacao_em: b.ultima_validacao_em || null,
          uid: user.ID,
          data_emissao_nf: b.data_emissao_nf || null,
          data_expedicao: b.data_expedicao || null,
          data_vencimento: b.data_vencimento || null,
          nf_saida: trim(b.nf_saida),
          serie_saida: trim(b.serie_saida),
          cfop_saida: trim(b.cfop_saida),
          valor: b.valor == null || b.valor === '' ? null : Number(b.valor),
          observacao: trim(b.observacao),
          cobranca_1a: trim(b.cobranca_1a),
          cobranca_2a: trim(b.cobranca_2a),
          origem: trim(b.origem)
        }
      );
      const envioId = ins[0].id;

      // Itens (opcional)
      if (Array.isArray(b.itens) && b.itens.length) {
        for (let i = 0; i < b.itens.length; i++) {
          const it = b.itens[i];
          await Pg.connectAndQuery(`
            INSERT INTO tab_pt_envio_item (envio_id, produto_cod, produto_desc, quantidade, valor_unit, serie_equip, ordem)
            VALUES (@eid, @cod, @desc, @qtd, @vu, @serie, @ord)`,
            {
              eid: envioId,
              cod: trim(it.produto_cod),
              desc: trim(it.produto_desc) || '(sem descricao)',
              qtd: it.quantidade == null ? 1 : Number(it.quantidade),
              vu: it.valor_unit == null || it.valor_unit === '' ? null : Number(it.valor_unit),
              serie: trim(it.serie_equip),
              ord: i
            }
          );
        }
      }

      return res.json({ ok: true, id: envioId });
    } catch (err) {
      console.error('pt-create:', err);
      return res.status(500).json({ message: 'Erro ao criar envio: ' + err.message });
    }
  }
});

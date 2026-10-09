// POST /ciosp/orcamentos/:uuid/converter — vira pedido. Perm 19002.
//
// A conversão COPIA os itens em vez de apontar para eles: o orçamento continua
// existindo exatamente como foi aprovado, mesmo que o pedido mude depois. É o que
// permite comparar valor orçado com valor vendido no painel.
//
// Aqui entram as regras que estão impressas no verso do talão de pedido:
//   - cláusula 5: frete grátis, menos na região amazônica, onde a venda é acrescida de 3%;
//   - cláusula 3: prazo de expedição em branco vale 30 dias.
//
// O documento do cliente, opcional no orçamento, passa a ser OBRIGATÓRIO aqui: é por
// ele que o ERP resolve o cliente quando a integração entrar (fase 5).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19002, 0]);
const Auditoria = require('../../services/auditoria');
const D = require('../../services/ciospDocs');

const EH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = (app) => ({
  verb: 'post',
  route: '/orcamentos/:uuid/converter',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const uuid = D.trim(req.params.uuid).toLowerCase();
    const b = req.body || {};
    const uuidPedido = D.trim(b.uuid_pedido).toLowerCase();

    if (!EH_UUID.test(uuidPedido)) {
      return res.status(400).json({ message: 'O pedido precisa de um uuid válido gerado no aparelho.' });
    }

    try {
      const r = await Pg.connectAndQuery(`SELECT * FROM tab_ciosp_orcamento WHERE uuid = @uuid`, { uuid });
      if (!r.length) return res.status(404).json({ message: 'Orçamento não encontrado.' });
      const o = r[0];

      // Idempotente: reenviar a conversão devolve o pedido que já existe, em vez de
      // criar um segundo. Vale para o tablet que perdeu a resposta e tentou de novo.
      const jaTem = await Pg.connectAndQuery(
        `SELECT id, uuid, numero FROM tab_ciosp_pedido WHERE orcamento_id = @id OR uuid = @uuidPedido`,
        { id: o.id, uuidPedido });
      if (jaTem.length) {
        return res.json({ ok: true, jaExistia: true, pedido: jaTem[0] });
      }

      if (!D.documentoValido(o.cliente_doc)) {
        return res.status(400).json({
          message: 'Para virar pedido o cliente precisa de CPF ou CNPJ — é por ele que o ERP identifica o comprador.'
        });
      }

      const itens = await D.lerItens(Pg, 'tab_ciosp_orcamento_item', 'orcamento_id', o.id);
      if (!itens.length) return res.status(400).json({ message: 'Orçamento sem itens.' });

      const ufEntrega = D.trim(b.entrega_uf || o.cliente_uf).toUpperCase() || null;
      const acrescimo = D.acrescimoAmazonia(ufEntrega, o.total);
      const freteValor = D.n2(b.frete_valor);
      const freteTipo = D.trim(b.frete_tipo) || 'gratis';
      const totalAVista = D.n2(D.N(o.total) + acrescimo + (freteTipo === 'comprador' ? freteValor : 0));
      const parcelas = Math.max(0, Math.round(D.N(b.parcelas)));
      const totalPrazo = D.n2(b.total_prazo) || totalAVista;

      const numero = await D.proximoNumero(Pg, 'tab_ciosp_pedido', o.edicao);
      const campos = {
        uuid: uuidPedido, edicao: o.edicao, numero, orcamento_id: o.id,
        cliente_doc: o.cliente_doc, cliente_nome: o.cliente_nome,
        cliente_cod: o.cliente_cod, cliente_loja: o.cliente_loja,
        cliente_rg_ie: D.trim(b.cliente_rg_ie).slice(0, 30) || null,
        cliente_resp: D.trim(b.cliente_resp).slice(0, 120) || null,
        cliente_cro: o.cliente_cro || D.trim(b.cliente_cro).slice(0, 20) || null,
        cliente_email: o.cliente_email, cliente_email2: o.cliente_email2,
        cliente_fone: o.cliente_fone, cliente_celular: o.cliente_celular,
        cliente_cep: o.cliente_cep, cliente_endereco: o.cliente_endereco,
        cliente_bairro: o.cliente_bairro, cliente_cidade: o.cliente_cidade, cliente_uf: o.cliente_uf,
        vendedor_id: o.vendedor_id, vendedor_nome: o.vendedor_nome,
        revenda: D.trim(b.revenda).slice(0, 120) || null,
        tabela_preco: o.tabela_preco,
        cond_pagto: D.trim(b.cond_pagto).slice(0, 60) || null,
        parcelas: parcelas || null,
        valor_parcela: parcelas > 0 ? D.n2(totalPrazo / parcelas) : null,
        frete_tipo: freteTipo, frete_valor: freteValor, acrescimo_norte: acrescimo,
        entrega_parcial: !!b.entrega_parcial,
        entrega_cep: D.trim(b.entrega_cep).slice(0, 9) || null,
        entrega_endereco: D.trim(b.entrega_endereco).slice(0, 200) || null,
        entrega_bairro: D.trim(b.entrega_bairro).slice(0, 80) || null,
        entrega_cidade: D.trim(b.entrega_cidade).slice(0, 80) || null,
        entrega_uf: ufEntrega,
        entrega_celular: D.trim(b.entrega_celular).slice(0, 40) || null,
        // Cláusula 3: sem prazo preenchido, o contrato considera 30 dias.
        prazo_entrega: b.prazo_entrega != null && D.N(b.prazo_entrega) > 0
          ? Math.round(D.N(b.prazo_entrega)) : D.PRAZO_EXPEDICAO_PADRAO,
        observacao: D.trim(b.observacao) || o.observacao,
        total_bruto: o.total_bruto, total_desconto: o.total_desconto,
        total: totalAVista, total_prazo: totalPrazo,
        dispositivo: D.trim(b.dispositivo).slice(0, 60) || null,
        por: user?.id ? Number(user.id) : null
      };

      const ins = await Pg.connectAndQuery(
        `INSERT INTO tab_ciosp_pedido
          (uuid, edicao, numero, orcamento_id, cliente_doc, cliente_nome, cliente_cod, cliente_loja,
           cliente_rg_ie, cliente_resp, cliente_cro, cliente_email, cliente_email2, cliente_fone,
           cliente_celular, cliente_cep, cliente_endereco, cliente_bairro, cliente_cidade, cliente_uf,
           vendedor_id, vendedor_nome, revenda, tabela_preco, cond_pagto, parcelas, valor_parcela,
           frete_tipo, frete_valor, acrescimo_norte, entrega_parcial, entrega_cep, entrega_endereco,
           entrega_bairro, entrega_cidade, entrega_uf, entrega_celular, prazo_entrega, observacao,
           total_bruto, total_desconto, total, total_prazo, dispositivo, criado_por, atualizado_por)
         VALUES (@uuid,@edicao,@numero,@orcamento_id,@cliente_doc,@cliente_nome,@cliente_cod,@cliente_loja,
                 @cliente_rg_ie,@cliente_resp,@cliente_cro,@cliente_email,@cliente_email2,@cliente_fone,
                 @cliente_celular,@cliente_cep,@cliente_endereco,@cliente_bairro,@cliente_cidade,@cliente_uf,
                 @vendedor_id,@vendedor_nome,@revenda,@tabela_preco,@cond_pagto,@parcelas,@valor_parcela,
                 @frete_tipo,@frete_valor,@acrescimo_norte,@entrega_parcial,@entrega_cep,@entrega_endereco,
                 @entrega_bairro,@entrega_cidade,@entrega_uf,@entrega_celular,@prazo_entrega,@observacao,
                 @total_bruto,@total_desconto,@total,@total_prazo,@dispositivo,@por,@por)
         RETURNING id`, campos);
      const pedidoId = ins[0].id;

      await D.gravarItens(Pg, 'tab_ciosp_pedido_item', 'pedido_id', pedidoId, itens);
      await Pg.connectAndQuery(
        `UPDATE tab_ciosp_orcamento SET situacao = 'convertido', atualizado_em = NOW(), atualizado_por = @por
          WHERE id = @id`, { id: o.id, por: campos.por });

      await D.registrar(Pg, 'orcamento', o.id, 'converteu', { para: `pedido ${numero}`, usuarioId: campos.por });
      await D.registrar(Pg, 'pedido', pedidoId, 'criou', { de: `orçamento ${o.numero}`, usuarioId: campos.por });

      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Pedido', acao: 'CRIAR', severidade: 'INFO',
        req, entidade: 'pedido', entidadeId: String(pedidoId),
        descricao: `Converteu orçamento ${o.numero} no pedido ${numero} — ${o.cliente_nome} · R$ ${totalAVista}`
      });

      return res.json({
        ok: true,
        pedido: { id: pedidoId, uuid: uuidPedido, numero },
        totais: { total_a_vista: totalAVista, total_prazo: totalPrazo, acrescimo_amazonia: acrescimo },
        aviso: acrescimo > 0
          ? `Entrega em ${ufEntrega}: contrato prevê acréscimo de 3% (R$ ${acrescimo.toFixed(2)}).`
          : null
      });
    } catch (err) {
      console.error('ciosp/orcamento-converter:', err.message);
      return res.status(500).json({ message: 'Erro ao converter em pedido: ' + err.message });
    }
  }
});

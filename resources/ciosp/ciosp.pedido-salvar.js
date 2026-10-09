// POST /ciosp/pedidos — cria ou atualiza um pedido do estande. Perm 19002.
//
// Serve aos dois caminhos que o processo tem: o pedido criado DIRETO pelo vendedor e
// o que nasceu de um orçamento (a conversão cria; aqui ele é completado com o que só
// o pedido tem — condição de pagamento, frete, entrega e os dados do contrato).
//
// Como no orçamento, a chave é o `uuid` do dispositivo: reenviar atualiza, nunca
// duplica. O documento do cliente é OBRIGATÓRIO aqui — é por ele que o ERP vai
// resolver o comprador quando a integração entrar.
//
// Os totais são sempre recalculados no servidor a partir dos itens e das regras do
// contrato (3% da região amazônica, frete por conta do comprador). O que o aparelho
// manda de total é conferência, não verdade.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19002, 0]);
const Auditoria = require('../../services/auditoria');
const D = require('../../services/ciospDocs');

const SITUACOES = ['rascunho', 'conferido', 'impresso', 'cancelado', 'integrado'];
const EH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = (app) => ({
  verb: 'post',
  route: '/pedidos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};
    const uuid = D.trim(b.uuid).toLowerCase();

    if (!EH_UUID.test(uuid)) {
      return res.status(400).json({ message: 'O pedido precisa de um uuid válido gerado no aparelho.' });
    }
    const situacao = D.trim(b.situacao) || 'rascunho';
    if (!SITUACOES.includes(situacao)) {
      return res.status(400).json({ message: `Situação inválida: ${situacao}.` });
    }
    const doc = D.soDig(b.cliente_doc);
    if (!D.documentoValido(doc)) {
      return res.status(400).json({ message: 'O pedido exige CPF ou CNPJ do cliente.' });
    }
    if (!D.trim(b.cliente_nome)) {
      return res.status(400).json({ message: 'Informe o nome do cliente.' });
    }

    try {
      const existe = await Pg.connectAndQuery(
        `SELECT id, numero, situacao, orcamento_id FROM tab_ciosp_pedido WHERE uuid = @uuid`, { uuid });
      const atual = existe[0] || null;

      if (atual && ['integrado', 'cancelado'].includes(atual.situacao) && situacao !== atual.situacao) {
        return res.status(409).json({
          message: `Pedido ${atual.situacao}: não pode mais ser alterado.`
        });
      }

      // Itens: no pedido que veio de orçamento eles já existem; só troca se vierem.
      let itens = null, totais = null;
      if (b.itens != null) {
        const r = D.montarItens(b.itens);
        if (r.erro) return res.status(400).json({ message: r.erro });
        itens = r.itens; totais = r.totais;
      } else if (atual) {
        const atuais = await D.lerItens(Pg, 'tab_ciosp_pedido_item', 'pedido_id', atual.id);
        totais = atuais.reduce((a, it) => ({
          total_bruto: D.n2(a.total_bruto + D.N(it.preco_tabela) * D.N(it.quantidade)),
          total: D.n2(a.total + D.N(it.total))
        }), { total_bruto: 0, total: 0 });
        totais.total_desconto = D.n2(totais.total_bruto - totais.total);
      } else {
        return res.status(400).json({ message: 'Inclua pelo menos um item.' });
      }

      const ufEntrega = D.trim(b.entrega_uf || b.cliente_uf).toUpperCase() || null;
      const freteTipo = D.trim(b.frete_tipo) || 'gratis';
      const freteValor = freteTipo === 'comprador' ? D.n2(b.frete_valor) : 0;
      const acrescimo = D.acrescimoAmazonia(ufEntrega, totais.total);
      const totalAVista = D.n2(totais.total + acrescimo + freteValor);
      const parcelas = Math.max(0, Math.round(D.N(b.parcelas)));
      const totalPrazo = D.n2(b.total_prazo) > 0 ? D.n2(b.total_prazo) : totalAVista;

      const campos = {
        uuid,
        edicao: D.trim(b.edicao) || 'CIOSP 2026',
        cliente_doc: doc,
        cliente_nome: D.trim(b.cliente_nome).slice(0, 200),
        cliente_cod: D.trim(b.cliente_cod).slice(0, 10) || null,
        cliente_loja: D.trim(b.cliente_loja).slice(0, 4) || null,
        cliente_rg_ie: D.trim(b.cliente_rg_ie).slice(0, 30) || null,
        cliente_resp: D.trim(b.cliente_resp).slice(0, 120) || null,
        cliente_cro: D.trim(b.cliente_cro).slice(0, 20) || null,
        cliente_email: D.trim(b.cliente_email).slice(0, 120) || null,
        cliente_email2: D.trim(b.cliente_email2).slice(0, 120) || null,
        cliente_fone: D.trim(b.cliente_fone).slice(0, 40) || null,
        cliente_celular: D.trim(b.cliente_celular).slice(0, 40) || null,
        cliente_cep: D.trim(b.cliente_cep).slice(0, 9) || null,
        cliente_endereco: D.trim(b.cliente_endereco).slice(0, 200) || null,
        cliente_bairro: D.trim(b.cliente_bairro).slice(0, 80) || null,
        cliente_cidade: D.trim(b.cliente_cidade).slice(0, 80) || null,
        cliente_uf: D.trim(b.cliente_uf).slice(0, 2).toUpperCase() || null,
        vendedor_nome: D.trim(b.vendedor_nome || user?.nome).slice(0, 120) || null,
        revenda: D.trim(b.revenda).slice(0, 120) || null,
        tabela_preco: D.trim(b.tabela_preco).slice(0, 10) || null,
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
        prazo_entrega: D.N(b.prazo_entrega) > 0 ? Math.round(D.N(b.prazo_entrega)) : D.PRAZO_EXPEDICAO_PADRAO,
        situacao,
        motivo_cancel: D.trim(b.motivo_cancel).slice(0, 200) || null,
        observacao: D.trim(b.observacao) || null,
        total_bruto: totais.total_bruto, total_desconto: totais.total_desconto,
        total: totalAVista, total_prazo: totalPrazo,
        dispositivo: D.trim(b.dispositivo).slice(0, 60) || null,
        por: user?.id ? Number(user.id) : null
      };

      let id, numero, novo = false;
      if (atual) {
        id = atual.id; numero = atual.numero;
        await Pg.connectAndQuery(
          `UPDATE tab_ciosp_pedido SET
             cliente_doc=@cliente_doc, cliente_nome=@cliente_nome, cliente_cod=@cliente_cod,
             cliente_loja=@cliente_loja, cliente_rg_ie=@cliente_rg_ie, cliente_resp=@cliente_resp,
             cliente_cro=@cliente_cro, cliente_email=@cliente_email, cliente_email2=@cliente_email2,
             cliente_fone=@cliente_fone, cliente_celular=@cliente_celular, cliente_cep=@cliente_cep,
             cliente_endereco=@cliente_endereco, cliente_bairro=@cliente_bairro,
             cliente_cidade=@cliente_cidade, cliente_uf=@cliente_uf, revenda=@revenda,
             cond_pagto=@cond_pagto, parcelas=@parcelas, valor_parcela=@valor_parcela,
             frete_tipo=@frete_tipo, frete_valor=@frete_valor, acrescimo_norte=@acrescimo_norte,
             entrega_parcial=@entrega_parcial, entrega_cep=@entrega_cep,
             entrega_endereco=@entrega_endereco, entrega_bairro=@entrega_bairro,
             entrega_cidade=@entrega_cidade, entrega_uf=@entrega_uf, entrega_celular=@entrega_celular,
             prazo_entrega=@prazo_entrega, situacao=@situacao, motivo_cancel=@motivo_cancel,
             observacao=@observacao, total_bruto=@total_bruto, total_desconto=@total_desconto,
             total=@total, total_prazo=@total_prazo, atualizado_em=NOW(), atualizado_por=@por
           WHERE id=@id`, { ...campos, id });
      } else {
        novo = true;
        numero = await D.proximoNumero(Pg, 'tab_ciosp_pedido', campos.edicao);
        const ins = await Pg.connectAndQuery(
          `INSERT INTO tab_ciosp_pedido
            (uuid, edicao, numero, cliente_doc, cliente_nome, cliente_cod, cliente_loja,
             cliente_rg_ie, cliente_resp, cliente_cro, cliente_email, cliente_email2, cliente_fone,
             cliente_celular, cliente_cep, cliente_endereco, cliente_bairro, cliente_cidade, cliente_uf,
             vendedor_id, vendedor_nome, revenda, tabela_preco, cond_pagto, parcelas, valor_parcela,
             frete_tipo, frete_valor, acrescimo_norte, entrega_parcial, entrega_cep, entrega_endereco,
             entrega_bairro, entrega_cidade, entrega_uf, entrega_celular, prazo_entrega, situacao,
             motivo_cancel, observacao, total_bruto, total_desconto, total, total_prazo, dispositivo,
             criado_por, atualizado_por)
           VALUES (@uuid,@edicao,@numero,@cliente_doc,@cliente_nome,@cliente_cod,@cliente_loja,
                   @cliente_rg_ie,@cliente_resp,@cliente_cro,@cliente_email,@cliente_email2,@cliente_fone,
                   @cliente_celular,@cliente_cep,@cliente_endereco,@cliente_bairro,@cliente_cidade,@cliente_uf,
                   @por,@vendedor_nome,@revenda,@tabela_preco,@cond_pagto,@parcelas,@valor_parcela,
                   @frete_tipo,@frete_valor,@acrescimo_norte,@entrega_parcial,@entrega_cep,@entrega_endereco,
                   @entrega_bairro,@entrega_cidade,@entrega_uf,@entrega_celular,@prazo_entrega,@situacao,
                   @motivo_cancel,@observacao,@total_bruto,@total_desconto,@total,@total_prazo,@dispositivo,
                   @por,@por)
           RETURNING id`, { ...campos, numero });
        id = ins[0].id;
      }

      if (itens) await D.gravarItens(Pg, 'tab_ciosp_pedido_item', 'pedido_id', id, itens);
      await D.registrar(Pg, 'pedido', id,
        novo ? 'criou' : (situacao !== atual?.situacao ? situacao : 'alterou'),
        { de: atual?.situacao, para: `${situacao} · R$ ${totalAVista}`, usuarioId: campos.por });

      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Pedido', acao: novo ? 'CRIAR' : 'EDITAR', severidade: 'INFO',
        req, entidade: 'pedido', entidadeId: String(id),
        descricao: `${novo ? 'Criou' : 'Alterou'} pedido ${numero} — ${campos.cliente_nome} · R$ ${totalAVista} · ${situacao}`
      });

      return res.json({
        ok: true, id, uuid, numero, situacao,
        totais: {
          total_bruto: totais.total_bruto, total_desconto: totais.total_desconto,
          acrescimo_amazonia: acrescimo, frete: freteValor,
          total_a_vista: totalAVista, total_prazo: totalPrazo,
          valor_parcela: campos.valor_parcela
        },
        aviso: acrescimo > 0
          ? `Entrega em ${ufEntrega}: contrato prevê acréscimo de 3% (R$ ${acrescimo.toFixed(2)}).`
          : null
      });
    } catch (err) {
      console.error('ciosp/pedido-salvar:', err.message);
      return res.status(500).json({ message: 'Erro ao salvar o pedido: ' + err.message });
    }
  }
});

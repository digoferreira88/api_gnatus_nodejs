// POST /ciosp/orcamentos/:uuid/converter — vira pedido. Perm 19002 (intranet) / 19005 (app).
//
// A conversão COPIA os itens em vez de apontar para eles: o orçamento continua
// existindo exatamente como foi aprovado, mesmo que o pedido mude depois. É o que
// permite comparar valor orçado com valor vendido no painel.
//
// Aqui entram as regras que estão impressas no verso do talão de pedido:
//   - cláusula 5: frete grátis, menos na região amazônica, onde a venda é acrescida de 3%;
//   - cláusula 3: prazo de expedição em branco vale 30 dias.
//
// Tabela (13/11) e forma de pagamento vêm SÓ do orçamento — são o que o servidor
// precificou e o gerente aprovou; trocar no corpo da conversão mudaria comissão e
// desconto sem aprovação. Para trocar, edita-se o orçamento.
//
// Tudo numa transação com a MESMA trava do salvar (uuid do orçamento): um salvar
// simultâneo não consegue enfiar preços novos entre a checagem do desconto e a cópia
// dos itens. A numeração do pedido trava por edição.
//
// O documento do cliente, opcional no orçamento, passa a ser OBRIGATÓRIO aqui: é por
// ele que o ERP resolve o cliente.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19002, 19005, 0]);
const equipeAtiva = require('../../middlewares/ciospEquipeAtiva');
const Auditoria = require('../../services/auditoria');
const D = require('../../services/ciospDocs');
const F = require('../../services/ciospFluxo');
const { q } = require('../../services/ciospEdicao');

const EH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_COLS = ['seq', 'produto', 'descricao', 'modelo', 'quantidade', 'preco_tabela', 'preco', 'desconto_pct',
  'total', 'cor_estofamento', 'voltagem', 'prazo_fabric', 'familia', 'preco_id', 'promocao_pct', 'promocao_texto',
  'promocao_condicional'];

module.exports = (app) => ({
  verb: 'post',
  route: '/orcamentos/:uuid/converter',
  middlewares: [requirePerm(app), equipeAtiva(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const uid = Number(user?.ID ?? user?.id) || null;
    const uuid = D.trim(req.params.uuid).toLowerCase();
    const b = req.body || {};
    const uuidPedido = D.trim(b.uuid_pedido).toLowerCase();

    if (!EH_UUID.test(uuid)) return res.status(404).json({ message: 'Orçamento não encontrado.' });
    if (!EH_UUID.test(uuidPedido)) {
      return res.status(400).json({ message: 'O pedido precisa de um uuid válido gerado no aparelho.' });
    }

    try {
      const so = await F.escopoVendedor(app, uid);
      const r = await Pg.withTransaction(async (db) => {
        await q(db, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`ciosp-orc-${uuid}`]);
        const os = await q(db, `SELECT * FROM tab_ciosp_orcamento WHERE uuid = $1 FOR UPDATE`, [uuid]);
        const o = os[0];
        // Quem só tem o app converte apenas os próprios orçamentos.
        if (!o || (so && Number(o.vendedor_id) !== so)) return { status: 404, erro: 'Orçamento não encontrado.' };

        // Idempotente: reenviar a conversão devolve o pedido que já existe, em vez de
        // criar um segundo. Vale para o aparelho que perdeu a resposta e tentou de novo.
        const jaTem = await q(db, `SELECT id, uuid, numero FROM tab_ciosp_pedido WHERE orcamento_id = $1 OR uuid = $2`,
          [o.id, uuidPedido]);
        if (jaTem.length) return { jaExistia: true, pedido: jaTem[0] };

        // Desconto acima do livre só vira pedido com o gerente de acordo (spec §6.1).
        if (['pendente', 'recusado'].includes(o.desconto_status)) {
          return {
            status: 409,
            erro: o.desconto_status === 'recusado'
              ? 'O gerente recusou o desconto: ajuste os preços antes de converter.'
              : 'O desconto passa do livre: peça a aprovação do gerente antes de converter.'
          };
        }
        if (!['rascunho', 'enviado'].includes(o.situacao)) {
          return { status: 409, erro: `Orçamento ${o.situacao}: não pode virar pedido.` };
        }
        if (!D.documentoValido(o.cliente_doc)) {
          return { status: 400, erro: 'Para virar pedido o cliente precisa de CPF ou CNPJ — é por ele que o ERP identifica o comprador.' };
        }

        const itens = await q(db,
          `SELECT ${ITEM_COLS.join(', ')} FROM tab_ciosp_orcamento_item WHERE orcamento_id = $1 ORDER BY seq`, [o.id]);
        if (!itens.length) return { status: 400, erro: 'Orçamento sem itens.' };

        const fp = await F.lerForma(app, o.forma_pagto_id, o.edicao);
        const forma = fp.forma || null;
        const ufEntrega = D.trim(b.entrega_uf || o.cliente_uf).toUpperCase() || null;
        const acrescimo = D.acrescimoAmazonia(ufEntrega, o.total);
        const freteTipo = D.trim(b.frete_tipo) || 'gratis';
        const freteValor = freteTipo === 'comprador' ? D.n2(b.frete_valor) : 0;
        const totalAVista = D.n2(D.N(o.total) + acrescimo + freteValor);
        const parcelas = Math.max(0, Math.round(D.N(b.parcelas)));
        const totalPrazo = D.n2(b.total_prazo) || totalAVista;

        await q(db, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`ciosp-ped-numero-${o.edicao}`]);
        const n = await q(db, `SELECT COALESCE(MAX(numero), 0) + 1 AS proximo FROM tab_ciosp_pedido WHERE edicao = $1`, [o.edicao]);
        const numero = Number(n[0].proximo);

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
          cond_pagto: forma ? String(forma.nome).slice(0, 60) : null,
          tabela_comissao: F.tabelaComissao(o.tabela_comissao),
          forma_pagto_id: forma ? forma.id : null,
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
          criado_por: uid, atualizado_por: uid
        };
        const cols = Object.keys(campos);
        const ins = await q(db,
          `INSERT INTO tab_ciosp_pedido (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          cols.map(c => campos[c]));
        const pedidoId = ins[0].id;

        for (const it of itens) {
          await q(db,
            `INSERT INTO tab_ciosp_pedido_item (pedido_id, ${ITEM_COLS.join(', ')})
             VALUES ($1, ${ITEM_COLS.map((_, i) => `$${i + 2}`).join(', ')})`,
            [pedidoId, ...ITEM_COLS.map(c => (c === 'promocao_condicional' ? !!it[c] : it[c]))]);
        }
        await q(db, `UPDATE tab_ciosp_orcamento SET situacao = 'convertido', atualizado_em = NOW(), atualizado_por = $2 WHERE id = $1`,
          [o.id, uid]);
        return { o, pedido: { id: pedidoId, uuid: uuidPedido, numero }, totalAVista, totalPrazo, acrescimo, ufEntrega };
      });

      if (r.erro) return res.status(r.status).json({ message: r.erro });
      if (r.jaExistia) return res.json({ ok: true, jaExistia: true, pedido: r.pedido });

      await D.registrar(Pg, 'orcamento', r.o.id, 'converteu', { para: `pedido ${r.pedido.numero}`, usuarioId: uid });
      await D.registrar(Pg, 'pedido', r.pedido.id, 'criou', { de: `orçamento ${r.o.numero}`, usuarioId: uid });
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Pedido', acao: 'CRIAR', severidade: 'INFO',
        req, entidade: 'pedido', entidadeId: String(r.pedido.id),
        descricao: `Converteu orçamento ${r.o.numero} no pedido ${r.pedido.numero} — ${r.o.cliente_nome} · R$ ${r.totalAVista}`
      });

      return res.json({
        ok: true,
        pedido: r.pedido,
        totais: { total_a_vista: r.totalAVista, total_prazo: r.totalPrazo, acrescimo_amazonia: r.acrescimo },
        aviso: r.acrescimo > 0
          ? `Entrega em ${r.ufEntrega}: contrato prevê acréscimo de 3% (R$ ${r.acrescimo.toFixed(2)}).`
          : null
      });
    } catch (err) {
      console.error('ciosp/orcamento-converter:', err.message);
      return res.status(500).json({ message: 'Erro ao converter em pedido: ' + err.message });
    }
  }
});

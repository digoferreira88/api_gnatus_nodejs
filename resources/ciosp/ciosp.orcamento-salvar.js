// POST /ciosp/orcamentos — cria ou atualiza um orçamento do estande. Perm 19002.
//
// A chave é o `uuid` gerado no DISPOSITIVO: reenviar o mesmo uuid atualiza, nunca
// cria um segundo. É o que vai permitir o modo offline da fase 3 sem duplicar
// orçamento quando a conexão volta no meio do envio.
//
// O número que o cliente vê (000123) é do servidor, por edição — o tablet não tem
// como saber qual é o próximo sem internet.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19002, 0]);
const Auditoria = require('../../services/auditoria');
const D = require('../../services/ciospDocs');

const SITUACOES = ['rascunho', 'enviado', 'negociando', 'aprovado', 'convertido', 'perdido', 'expirado'];
const EH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = (app) => ({
  verb: 'post',
  route: '/orcamentos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};
    const uuid = D.trim(b.uuid).toLowerCase();

    if (!EH_UUID.test(uuid)) {
      return res.status(400).json({ message: 'O orçamento precisa de um uuid válido gerado no aparelho.' });
    }
    const situacao = D.trim(b.situacao) || 'rascunho';
    if (!SITUACOES.includes(situacao)) {
      return res.status(400).json({ message: `Situação inválida: ${situacao}.` });
    }
    if (!D.trim(b.cliente_nome)) {
      return res.status(400).json({ message: 'Informe o nome do cliente.' });
    }
    // No orçamento o documento é opcional (o cliente pode nem ter decidido comprar);
    // no pedido ele vira obrigatório, porque é por ele que o ERP resolve o cliente.
    const doc = D.soDig(b.cliente_doc);
    if (doc && !D.documentoValido(doc)) {
      return res.status(400).json({ message: 'CPF/CNPJ com tamanho inválido.' });
    }

    const { erro, itens, totais } = D.montarItens(b.itens);
    if (erro) return res.status(400).json({ message: erro });

    const campos = {
      uuid,
      edicao: D.trim(b.edicao) || 'CIOSP 2026',
      cliente_doc: doc || null,
      cliente_nome: D.trim(b.cliente_nome).slice(0, 200),
      cliente_cod: D.trim(b.cliente_cod).slice(0, 10) || null,
      cliente_loja: D.trim(b.cliente_loja).slice(0, 4) || null,
      cliente_tipo: D.trim(b.cliente_tipo).slice(0, 20) || null,
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
      vendedor_id: user?.id ? Number(user.id) : null,
      vendedor_nome: D.trim(b.vendedor_nome || user?.nome).slice(0, 120) || null,
      tabela_preco: D.trim(b.tabela_preco).slice(0, 10) || null,
      validade: D.trim(b.validade) || null,
      situacao,
      motivo_perda: D.trim(b.motivo_perda).slice(0, 200) || null,
      observacao: D.trim(b.observacao) || null,
      total_bruto: totais.total_bruto,
      total_desconto: totais.total_desconto,
      total: totais.total,
      dispositivo: D.trim(b.dispositivo).slice(0, 60) || null,
      por: user?.id ? Number(user.id) : null
    };

    try {
      const existe = await Pg.connectAndQuery(
        `SELECT id, numero, situacao FROM tab_ciosp_orcamento WHERE uuid = @uuid`, { uuid });

      let id, numero, novo = false;
      if (existe.length) {
        id = existe[0].id;
        numero = existe[0].numero;
        if (existe[0].situacao === 'convertido') {
          return res.status(409).json({ message: 'Este orçamento já virou pedido e não pode mais ser alterado.' });
        }
        await Pg.connectAndQuery(
          `UPDATE tab_ciosp_orcamento SET
             edicao=@edicao, cliente_doc=@cliente_doc, cliente_nome=@cliente_nome,
             cliente_cod=@cliente_cod, cliente_loja=@cliente_loja, cliente_tipo=@cliente_tipo,
             cliente_cro=@cliente_cro, cliente_email=@cliente_email, cliente_email2=@cliente_email2,
             cliente_fone=@cliente_fone, cliente_celular=@cliente_celular, cliente_cep=@cliente_cep,
             cliente_endereco=@cliente_endereco, cliente_bairro=@cliente_bairro,
             cliente_cidade=@cliente_cidade, cliente_uf=@cliente_uf,
             tabela_preco=@tabela_preco, validade=@validade, situacao=@situacao,
             motivo_perda=@motivo_perda, observacao=@observacao,
             total_bruto=@total_bruto, total_desconto=@total_desconto, total=@total,
             atualizado_em=NOW(), atualizado_por=@por
           WHERE id=@id`, { ...campos, id });
      } else {
        novo = true;
        numero = await D.proximoNumero(Pg, 'tab_ciosp_orcamento', campos.edicao);
        const ins = await Pg.connectAndQuery(
          `INSERT INTO tab_ciosp_orcamento
            (uuid, edicao, numero, cliente_doc, cliente_nome, cliente_cod, cliente_loja,
             cliente_tipo, cliente_cro, cliente_email, cliente_email2, cliente_fone,
             cliente_celular, cliente_cep, cliente_endereco, cliente_bairro, cliente_cidade,
             cliente_uf, vendedor_id, vendedor_nome, tabela_preco, validade, situacao,
             motivo_perda, observacao, total_bruto, total_desconto, total, dispositivo,
             criado_por, atualizado_por)
           VALUES (@uuid,@edicao,@numero,@cliente_doc,@cliente_nome,@cliente_cod,@cliente_loja,
                   @cliente_tipo,@cliente_cro,@cliente_email,@cliente_email2,@cliente_fone,
                   @cliente_celular,@cliente_cep,@cliente_endereco,@cliente_bairro,@cliente_cidade,
                   @cliente_uf,@vendedor_id,@vendedor_nome,@tabela_preco,@validade,@situacao,
                   @motivo_perda,@observacao,@total_bruto,@total_desconto,@total,@dispositivo,
                   @por,@por)
           RETURNING id`, { ...campos, numero });
        id = ins[0].id;
      }

      await D.gravarItens(Pg, 'tab_ciosp_orcamento_item', 'orcamento_id', id, itens);
      await D.registrar(Pg, 'orcamento', id, novo ? 'criou' : 'alterou', {
        para: `${situacao} · R$ ${totais.total}`, usuarioId: campos.por
      });

      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Orçamento', acao: novo ? 'CRIAR' : 'EDITAR', severidade: 'INFO',
        req, entidade: 'orcamento', entidadeId: String(id),
        descricao: `${novo ? 'Criou' : 'Alterou'} orçamento ${numero} — ${campos.cliente_nome} · R$ ${totais.total}`
      });

      return res.json({ ok: true, id, uuid, numero, situacao, totais, itens: itens.length });
    } catch (err) {
      console.error('ciosp/orcamento-salvar:', err.message);
      return res.status(500).json({ message: 'Erro ao salvar o orçamento: ' + err.message });
    }
  }
});

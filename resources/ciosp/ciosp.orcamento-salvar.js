// POST /ciosp/orcamentos — cria ou atualiza um orçamento do estande.
// Perm 19002 (intranet) ou 19005 (app do estande).
//
// A chave é o `uuid` gerado no APARELHO: reenviar o mesmo uuid atualiza, nunca cria
// um segundo — é o que deixa o app trabalhar offline e reenviar sem medo. O número
// que o cliente vê (000123) é do servidor, por edição.
//
// Quem manda no preço é o servidor (spec §5): cada item da Tabela Comercial é
// recalculado pela tabela (13/11) e pela forma de pagamento; se a tabela mudou desde
// que o aparelho calculou, grava o preço do servidor e devolve `preco_mudou` com as
// diferenças para o vendedor revisar. A situação do desconto (livre / pendente /
// aprovado / recusado) é recalculada a cada gravação: aprovação vale para os mesmos
// preços (hash).
//
// Tudo numa transação com trava pelo uuid (e pela numeração da edição): duas
// tentativas simultâneas do mesmo orçamento — a resposta que se perdeu no 4G e o
// reenvio — não duplicam itens nem número.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19002, 19005, 0]);
const equipeAtiva = require('../../middlewares/ciospEquipeAtiva');
const Auditoria = require('../../services/auditoria');
const D = require('../../services/ciospDocs');
const F = require('../../services/ciospFluxo');
const P = require('../../services/ciospPreco');
const O = require('../../services/ciospOrcamento');
const E = require('../../services/ciospEdicao');
const { q } = E;

const EH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Enviado ao cliente e alterado volta a rascunho (precisa de novo envio).
const EDITAVEIS = ['rascunho', 'enviado'];
const ITEM_COLS = ['seq', 'produto', 'descricao', 'modelo', 'quantidade', 'preco_tabela', 'preco', 'desconto_pct',
  'total', 'cor_estofamento', 'voltagem', 'prazo_fabric', 'familia', 'preco_id', 'promocao_pct', 'promocao_texto',
  'promocao_condicional'];

const hojeMais = (dias) => {
  const d = new Date(Date.now() + dias * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
};

module.exports = (app) => ({
  verb: 'post',
  route: '/orcamentos',
  middlewares: [requirePerm(app), equipeAtiva(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const uid = Number(user?.ID ?? user?.id) || null;
    const b = req.body || {};
    const uuid = D.trim(b.uuid).toLowerCase();

    if (!EH_UUID.test(uuid)) {
      return res.status(400).json({ message: 'O orçamento precisa de um uuid válido gerado no aparelho.' });
    }
    // Do aparelho só vem rascunho ou perdido; "enviado" é do envio ao cliente (Entrega 4)
    // e "convertido" da conversão.
    const pedida = D.trim(b.situacao) || 'rascunho';
    if (!['rascunho', 'perdido'].includes(pedida)) {
      return res.status(400).json({ message: `Situação inválida: ${pedida}.` });
    }
    if (pedida === 'perdido' && D.trim(b.motivo_perda).length < 3) {
      return res.status(400).json({ message: 'Informe o motivo da perda.' });
    }
    if (!D.trim(b.cliente_nome)) return res.status(400).json({ message: 'Informe o nome do cliente.' });
    // No orçamento o documento é opcional; no pedido ele vira obrigatório.
    const doc = D.soDig(b.cliente_doc);
    if (doc && !D.documentoValido(doc)) return res.status(400).json({ message: 'CPF/CNPJ com tamanho inválido.' });

    try {
      const so = await F.escopoVendedor(app, uid);
      const cfgAtiva = await E.getConfig(app);

      const r = await Pg.withTransaction(async (db) => {
        await q(db, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`ciosp-orc-${uuid}`]);
        const ex = await q(db,
          `SELECT id, numero, situacao, vendedor_id, vendedor_nome, edicao, desconto_status, desconto_hash,
                  desconto_solicitado_em
             FROM tab_ciosp_orcamento WHERE uuid = $1 FOR UPDATE`, [uuid]);
        const atual = ex[0] || null;

        if (atual && so && Number(atual.vendedor_id) !== so) return { status: 404, erro: 'Orçamento não encontrado.' };
        if (atual && !EDITAVEIS.includes(atual.situacao)) {
          return { status: 409, erro: `Orçamento ${atual.situacao}: não pode mais ser alterado.` };
        }

        const edicao = atual ? atual.edicao : (D.trim(b.edicao) || cfgAtiva.edicao);
        if (!edicao) return { status: 400, erro: 'Nenhuma edição do CIOSP está ativa.' };

        // Quem só tem o app precisa estar na equipe do evento.
        let membro = null;
        if (!atual) {
          const m = await q(db, `SELECT nome_exibicao FROM tab_ciosp_equipe WHERE edicao = $1 AND usuario_id = $2 AND ativo`,
            [edicao, uid]);
          membro = m[0] || null;
          if (so && !membro) return { status: 403, erro: `Você não está na equipe do ${edicao}.` };
        }

        const tabela = F.tabelaComissao(b.tabela_comissao);
        const fp = await F.lerForma(app, b.forma_pagto_id, edicao);
        if (fp.erro) return { status: 400, erro: fp.erro };
        const entrada = Array.isArray(b.itens) ? b.itens : [];
        if (entrada.some(it => it.preco_id != null && it.preco_id !== '') && (!tabela || !fp.forma)) {
          return { status: 400, erro: 'Escolha a tabela (13% ou 11%) e a forma de pagamento.' };
        }

        const ids = [...new Set(entrada.map(it => Number(it.preco_id)).filter(n => Number.isInteger(n) && n > 0))];
        // Inclui linhas já desativadas: depois de uma reimportação o aparelho ainda manda o
        // id antigo, que vira a linha nova equivalente (ciospOrcamento.linhasVigentes).
        let linhas = new Map();
        if (ids.length) {
          const pedidas = await q(db, `SELECT * FROM tab_ciosp_preco WHERE edicao = $1 AND id = ANY($2::int[])`, [edicao, ids]);
          const ativas = pedidas.every(l => l.ativo)
            ? pedidas
            : await q(db, `SELECT * FROM tab_ciosp_preco WHERE edicao = $1 AND ativo`, [edicao]);
          linhas = O.linhasVigentes(pedidas, ativas);
        }
        const cfg = edicao === cfgAtiva.edicao ? cfgAtiva : await E.getConfig(app, edicao);
        const rec = O.recalcularItens(entrada, { linhas, tabela, forma: fp.forma || {}, config: cfg });
        const montado = D.montarItens(rec.itens);
        if (montado.erro) return { status: 400, erro: montado.erro };
        const { itens, totais } = montado;

        const hash = P.hashAprovacao({ itens, tabela, forma_id: fp.forma ? fp.forma.id : null });
        const desconto = O.estadoDesconto({ exige: rec.exige, hash, atual: atual || {} });

        const campos = {
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
          tabela_preco: D.trim(b.tabela_preco).slice(0, 10) || null,
          tabela_comissao: tabela,
          forma_pagto_id: fp.forma ? fp.forma.id : null,
          validade: D.trim(b.validade) || hojeMais(Number(cfg.validade_orcamento_dias) || 7),
          situacao: pedida,
          motivo_perda: pedida === 'perdido' ? D.trim(b.motivo_perda).slice(0, 200) : null,
          observacao: D.trim(b.observacao) || null,
          total_bruto: totais.total_bruto,
          total_desconto: totais.total_desconto,
          total: totais.total,
          ...desconto,
          versao_pacote: D.trim(b.versao_pacote).slice(0, 40) || null,
          aparelho_atualizado_em: b.aparelho_atualizado_em && !Number.isNaN(Date.parse(b.aparelho_atualizado_em))
            ? new Date(b.aparelho_atualizado_em) : null,
          dispositivo: D.trim(b.dispositivo).slice(0, 60) || null,
          atualizado_por: uid
        };

        let id, numero;
        if (atual) {
          id = atual.id; numero = atual.numero;
          const cols = Object.keys(campos);
          await q(db,
            `UPDATE tab_ciosp_orcamento SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, atualizado_em = NOW()
              WHERE id = $1`, [id, ...cols.map(c => campos[c])]);
        } else {
          await q(db, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`ciosp-orc-numero-${edicao}`]);
          const n = await q(db, `SELECT COALESCE(MAX(numero), 0) + 1 AS proximo FROM tab_ciosp_orcamento WHERE edicao = $1`, [edicao]);
          numero = Number(n[0].proximo);
          const novo = {
            uuid, edicao, numero, ...campos,
            vendedor_id: uid,
            vendedor_nome: D.trim((membro && membro.nome_exibicao) || b.vendedor_nome || user?.nome).slice(0, 120) || null,
            criado_por: uid
          };
          const cols = Object.keys(novo);
          const ins = await q(db,
            `INSERT INTO tab_ciosp_orcamento (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
             RETURNING id`, cols.map(c => novo[c]));
          id = ins[0].id;
        }

        await q(db, `DELETE FROM tab_ciosp_orcamento_item WHERE orcamento_id = $1`, [id]);
        for (const it of itens) {
          const v = { ...it, promocao_condicional: !!it.promocao_condicional };
          await q(db,
            `INSERT INTO tab_ciosp_orcamento_item (orcamento_id, ${ITEM_COLS.join(', ')})
             VALUES ($1, ${ITEM_COLS.map((_, i) => `$${i + 2}`).join(', ')})`,
            [id, ...ITEM_COLS.map(c => (v[c] === undefined ? null : v[c]))]);
        }
        return { atual, id, numero, edicao, campos, itens, totais, rec };
      });

      if (r.erro) return res.status(r.status || 400).json({ message: r.erro });

      const { atual, id, numero, edicao, campos, itens, totais, rec } = r;
      await D.registrar(Pg, 'orcamento', id, atual ? 'alterou' : 'criou', {
        de: atual ? atual.situacao : null,
        para: `${campos.situacao} · R$ ${totais.total} · desconto ${campos.desconto_status}`, usuarioId: uid
      });
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Orçamento', acao: atual ? 'EDITAR' : 'CRIAR', severidade: 'INFO',
        req, entidade: 'orcamento', entidadeId: String(id),
        descricao: `${atual ? 'Alterou' : 'Criou'} orçamento ${numero} — ${campos.cliente_nome} · R$ ${totais.total}`
      });

      return res.json({
        ok: true,
        orcamento: {
          id, uuid, numero, edicao, situacao: campos.situacao, validade: campos.validade,
          tabela_comissao: campos.tabela_comissao, forma_pagto_id: campos.forma_pagto_id,
          desconto_status: campos.desconto_status, desconto_solicitado_em: campos.desconto_solicitado_em,
          total_bruto: totais.total_bruto, total_desconto: totais.total_desconto, total: totais.total
        },
        itens,
        totais,
        preco_mudou: rec.diferencas.length > 0,
        diferencas: rec.diferencas
      });
    } catch (err) {
      console.error('ciosp/orcamento-salvar:', err.message);
      return res.status(500).json({ message: 'Erro ao salvar o orçamento: ' + err.message });
    }
  }
});

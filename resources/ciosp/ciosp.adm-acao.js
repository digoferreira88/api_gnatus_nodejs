// POST /ciosp/adm/pedidos/:uuid/:acao — checklist do ADM. Perm 19004.
//
// Ações: assumir (tomar), devolver, conferir, credito, contrato, protheus, ajustar,
// finalizar, cancelar. As regras de cada uma estão em services/ciospFluxo.js; aqui
// a ação roda numa transação com o pedido travado (SELECT … FOR UPDATE), de modo que
// dois ADMs clicando juntos não se atropelam, e a linha do painel é acertada na MESMA
// transação (services/ciospPainel.js): se ela não fecha, nada é gravado.
//
// A conferência do nº no Protheus é feita ANTES de abrir a transação — é uma consulta
// de rede ao SQL Server e não deve segurar a trava do pedido.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const Auditoria = require('../../services/auditoria');
const D = require('../../services/ciospDocs');
const F = require('../../services/ciospFluxo');
const Painel = require('../../services/ciospPainel');
const { q } = require('../../services/ciospEdicao');

// Só estas colunas podem ser gravadas por uma ação do ADM.
const COLUNAS = [
  'adm_responsavel', 'adm_assumiu_em', 'conferido_por', 'conferido_em', 'devolvido_motivo',
  'credito_status', 'credito_parecer', 'credito_por', 'credito_em',
  'contrato_assinado_por', 'contrato_assinado_em',
  'protheus_pedido', 'protheus_conferido', 'protheus_conferido_em',
  'painel_categoria', 'painel_gerente', 'painel_equipe',
  'finalizado_por', 'finalizado_em', 'motivo_cancel', 'cancelado_por', 'cancelado_em'
];

const AVISO_PROTHEUS = {
  divergente: (n) => `O pedido ${n} existe no Protheus, mas é de outro CPF/CNPJ. Confira antes de finalizar.`,
  nao_encontrado: (n) => `Não achei o pedido ${n} no Protheus. Confira o número.`,
  nao_conferido: (n) => `O Protheus não respondeu: o pedido ${n} foi gravado sem conferência.`
};

module.exports = (app) => ({
  verb: 'post',
  route: '/adm/pedidos/:uuid/:acao',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const uid = Number(user?.ID ?? user?.id) || null;
    const uuid = D.trim(req.params.uuid).toLowerCase();
    const acao = D.trim(req.params.acao);
    const dados = req.body || {};

    if (!F.ACOES_ADM.includes(acao)) return res.status(404).json({ message: 'Ação desconhecida.' });

    try {
      let protheusConferido = null;
      const numeroProtheus = D.trim(dados.numero);
      if (acao === 'protheus' && /^\d{1,6}$/.test(numeroProtheus)) {
        const p0 = await Pg.connectAndQuery(`SELECT cliente_doc FROM tab_ciosp_pedido WHERE uuid = @uuid`, { uuid });
        if (p0.length) {
          protheusConferido = await F.conferirNumeroProtheus(app, numeroProtheus.padStart(6, '0'), p0[0].cliente_doc);
        }
      }

      const r = await Pg.withTransaction(async (db) => {
        const ped = await q(db, `SELECT * FROM tab_ciosp_pedido WHERE uuid = $1 FOR UPDATE`, [uuid]);
        if (!ped.length) return { status: 404, erro: 'Pedido não encontrado.' };
        const pedido = ped[0];

        const resp = pedido.adm_responsavel
          ? await q(db, `SELECT nome FROM tab_intranet_usr WHERE id = $1`, [pedido.adm_responsavel])
          : [];
        const ctxPainel = await Painel.contextoPainel(db, pedido);
        const resultado = F.aplicarAcao(pedido, acao, dados, {
          usuarioId: uid,
          agora: new Date(),
          forma: ctxPainel.forma || {},
          erroPainel: acao === 'conferir' ? Painel.linhaPainel(pedido, ctxPainel).erro : undefined,
          protheusConferido,
          nomeResponsavel: resp[0] ? resp[0].nome : null,
          nomeUsuario: user?.nome || null
        });
        if (resultado.erro) return resultado;

        // Se o pedido continua (ou passa a estar) no painel, a linha tem que fechar
        // com os campos novos — ex.: tirar a categoria de um pedido conferido.
        if (Painel.exigeLinhaPainel(acao, resultado.situacao)) {
          const depois = { ...pedido, ...resultado.campos, situacao: resultado.situacao };
          const erroLinha = Painel.linhaPainel(depois, ctxPainel).erro;
          if (erroLinha) return { status: 400, erro: erroLinha };
        }

        const campos = Object.keys(resultado.campos).filter(c => COLUNAS.includes(c));
        const mudou = campos.length > 0 || resultado.situacao !== pedido.situacao;
        if (mudou) {
          const sets = campos.map((c, i) => `${c} = $${i + 4}`);
          await q(db,
            `UPDATE tab_ciosp_pedido
                SET situacao = $2, atualizado_em = NOW(), atualizado_por = $3${sets.length ? ', ' + sets.join(', ') : ''}
              WHERE id = $1`,
            [pedido.id, resultado.situacao, uid, ...campos.map(c => resultado.campos[c])]);
        }
        // Assumir/tomar não mexe no painel (ver exigeLinhaPainel): só lê a linha atual.
        const painel = acao === 'assumir'
          ? ((await q(db, `SELECT id AS venda_id, situacao_fin FROM tab_ciosp_venda WHERE pedido_id = $1`, [pedido.id]))[0]
            || { venda_id: null, situacao_fin: null })
          : await Painel.sincronizarPainel(db, pedido.id);
        return { pedido, resultado, painel, mudou };
      });

      if (r.erro) return res.status(r.status || 400).json({ message: r.erro });

      const { pedido, resultado, painel, mudou } = r;
      if (mudou) {
        await D.registrar(Pg, 'pedido', pedido.id, resultado.log.acao,
          { de: pedido.situacao, para: resultado.log.para || resultado.situacao, usuarioId: uid });
        Auditoria.registrar(app, {
          modulo: 'CIOSP', submodulo: 'Fila do ADM', acao: acao.toUpperCase(),
          severidade: acao === 'cancelar' ? 'AVISO' : 'INFO',
          req, entidade: 'pedido', entidadeId: String(pedido.id),
          descricao: `Pedido ${pedido.numero} (${pedido.cliente_nome}): ${resultado.log.acao}` +
            (resultado.log.para ? ` — ${resultado.log.para}` : '') + ` · ${pedido.situacao} → ${resultado.situacao}`
        });
      }

      const numero = resultado.campos.protheus_pedido;
      const aviso = acao === 'protheus' && numero && AVISO_PROTHEUS[resultado.campos.protheus_conferido]
        ? AVISO_PROTHEUS[resultado.campos.protheus_conferido](numero) : null;

      return res.json({
        ok: true,
        situacao: resultado.situacao,
        venda: painel.venda_id ? { id: painel.venda_id, situacao_fin: painel.situacao_fin } : null,
        aviso
      });
    } catch (err) {
      console.error('ciosp/adm-acao:', err.message);
      return res.status(500).json({ message: 'Erro na ação do pedido: ' + err.message });
    }
  }
});

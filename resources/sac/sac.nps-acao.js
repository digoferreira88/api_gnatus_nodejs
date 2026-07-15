// POST /sac/nps/acao/:conviteId
// Body: { tipo: 'OCTADESK'|'CONTATO'|'OUTRO', observacao?, abrirTicket?: bool,
//         assunto?, descricao? }
// Registra a ação tomada sobre um detrator. Se tipo=OCTADESK e abrirTicket=true,
// tenta abrir o ticket via services/octadesk (que ainda aguarda a doc da API —
// se não configurado, registra a ação com aviso, sem falhar). Perm 6003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6003]);
const Auditoria = require('../../services/auditoria');
const Octadesk = require('../../services/octadesk');
const trim = (v) => String(v == null ? '' : v).trim();

const TIPOS = ['OCTADESK', 'CONTATO', 'OUTRO'];

module.exports = (app) => ({
  verb: 'post',
  route: '/nps/acao/:conviteId',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const conviteId = Number(req.params.conviteId);
    if (!Number.isInteger(conviteId) || conviteId <= 0) return res.status(400).json({ message: 'convite inválido.' });

    const b = req.body || {};
    const tipo = TIPOS.includes(trim(b.tipo)) ? trim(b.tipo) : 'OUTRO';
    const observacao = trim(b.observacao).slice(0, 2000) || null;

    try {
      const conv = await Pg.connectAndQuery(
        `SELECT id, pedido, cliente_nome, telefone, cnpj, nota_nps FROM tab_nps_convite WHERE id = @id`, { id: conviteId });
      if (!conv.length) return res.status(404).json({ message: 'Convite não encontrado.' });
      const c = conv[0];

      let ticketId = null, ticketUrl = null, avisoOctadesk = null;
      if (tipo === 'OCTADESK' && b.abrirTicket) {
        const motivoResp = await Pg.connectAndQuery(
          `SELECT texto FROM tab_nps_resposta WHERE convite_id = @id AND texto IS NOT NULL AND texto <> '' ORDER BY id LIMIT 1`, { id: conviteId });
        const r = await Octadesk.criarTicket({
          nome: trim(c.cliente_nome), telefone: trim(c.telefone), pedido: trim(c.pedido), nota: c.nota_nps,
          assunto: trim(b.assunto) || `NPS Detrator — pedido ${trim(c.pedido)} (nota ${c.nota_nps})`,
          descricao: trim(b.descricao) || `Cliente detrator na pesquisa de pós-venda.\nPedido: ${trim(c.pedido)} · Nota: ${c.nota_nps}\nMotivo informado: ${trim(motivoResp[0]?.texto) || '—'}`
        });
        if (r.ok) { ticketId = r.ticketId; ticketUrl = r.url; }
        else avisoOctadesk = r.motivo === 'nao_configurado'
          ? 'Ticket NÃO aberto: integração Octadesk ainda não configurada (aguardando doc da API). A ação foi registrada mesmo assim.'
          : `Falha ao abrir ticket no Octadesk: ${r.motivo}. A ação foi registrada.`;
      }

      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_nps_acao (convite_id, tipo, octadesk_ticket_id, octadesk_url, observacao, usuario_id, usuario_nome)
        VALUES (@cid, @tipo, @tk, @url, @obs, @uid, @unome) RETURNING id`,
        { cid: conviteId, tipo, tk: ticketId, url: ticketUrl, obs: observacao, uid: user.ID, unome: trim(user.NOME) || trim(user.EMAIL) });

      Auditoria.registrar(app, {
        modulo: 'SAC', submodulo: 'NPS', acao: 'ACAO_DETRATOR', severidade: 'INFO', req,
        entidade: 'nps_acao', entidadeId: String(ins[0].id),
        descricao: `Ação ${tipo} no detrator pedido ${trim(c.pedido)} (${trim(c.cliente_nome)})${ticketId ? ' · ticket ' + ticketId : ''}`,
        meta: { conviteId, tipo, ticketId }
      });

      return res.json({ ok: true, id: ins[0].id, ticketId, ticketUrl, aviso: avisoOctadesk });
    } catch (err) {
      console.error('sac/nps-acao:', err);
      return res.status(500).json({ message: 'Erro ao registrar ação: ' + err.message });
    }
  }
});

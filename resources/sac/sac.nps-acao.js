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
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const conviteId = Number(req.params.conviteId);
    if (!Number.isInteger(conviteId) || conviteId <= 0) return res.status(400).json({ message: 'convite inválido.' });

    const b = req.body || {};
    const tipo = TIPOS.includes(trim(b.tipo)) ? trim(b.tipo) : 'OUTRO';
    const observacao = trim(b.observacao).slice(0, 2000) || null;
    const causa = trim(b.causa).slice(0, 160) || null;   // regra CX: classificar a causa do detrator

    try {
      const conv = await Pg.connectAndQuery(
        `SELECT id, pedido, cliente_cod, cliente_loja, cliente_nome, telefone, cnpj, nota_nps,
                bu_nome, vendedor_nome, transportadora_nome, linha_desc
           FROM tab_nps_convite WHERE id = @id`, { id: conviteId });
      if (!conv.length) return res.status(404).json({ message: 'Convite não encontrado.' });
      const c = conv[0];

      let ticketId = null, ticketUrl = null, avisoOctadesk = null;
      if (tipo === 'OCTADESK' && b.abrirTicket) {
        const motivoResp = await Pg.connectAndQuery(
          `SELECT pergunta_texto, nota, texto FROM tab_nps_resposta WHERE convite_id = @id ORDER BY id`, { id: conviteId });
        const motivo = trim((motivoResp.find(r => trim(r.texto))?.texto));

        // E-mail do cliente (SA1) — o requester do Octadesk associa/cria o contato
        let email = '';
        try {
          if (trim(c.cliente_cod)) {
            const sa1 = await Protheus.connectAndQuery(
              `SELECT TOP 1 RTRIM(A1_EMAIL) email FROM SA1010 WITH (NOLOCK)
                WHERE A1_COD=@cod AND A1_LOJA=@loja AND D_E_L_E_T_<>'*'`,
              { cod: trim(c.cliente_cod), loja: trim(c.cliente_loja) });
            email = trim(sa1[0]?.email);
          }
        } catch (e) { console.warn('nps-acao: SA1 email lookup:', e.message); }

        const linhas = [
          `Cliente detrator na pesquisa de pós-venda da Gnatus.`,
          ``,
          `Cliente: ${trim(c.cliente_nome)} (${trim(c.cliente_cod)}/${trim(c.cliente_loja)})`,
          `Pedido: ${trim(c.pedido)}`,
          `Nota NPS: ${c.nota_nps}`,
          c.bu_nome ? `BU: ${trim(c.bu_nome)}` : null,
          c.vendedor_nome ? `Vendedor: ${trim(c.vendedor_nome)}` : null,
          c.transportadora_nome ? `Transportadora: ${trim(c.transportadora_nome)}` : null,
          c.linha_desc ? `Linha: ${trim(c.linha_desc)}` : null,
          trim(c.telefone) ? `Telefone: ${trim(c.telefone)}` : null,
          ``,
          `Motivo informado: ${motivo || '—'}`
        ].filter(l => l !== null).join('\n');

        const r = await Octadesk.criarTicket({
          summary: trim(b.assunto) || `NPS Detrator — pedido ${trim(c.pedido)} (nota ${c.nota_nps})`,
          description: trim(b.descricao) ? `${trim(b.descricao)}\n\n${linhas}` : linhas,
          requesterName: trim(c.cliente_nome), requesterEmail: email,
          tags: ['NPS', 'Detrator', `nota-${c.nota_nps}`]
        });
        if (r.ok) { ticketId = r.ticketId || r.number; ticketUrl = r.url; }
        else avisoOctadesk = r.motivo === 'nao_configurado'
          ? 'Ticket NÃO aberto: integração Octadesk não configurada (defina OCTADESK_API_KEY e OCTADESK_AGENT_EMAIL no .env). A ação foi registrada.'
          : `Falha ao abrir ticket no Octadesk: ${r.motivo}. A ação foi registrada.`;
      }

      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_nps_acao (convite_id, tipo, causa, octadesk_ticket_id, octadesk_url, observacao, usuario_id, usuario_nome)
        VALUES (@cid, @tipo, @causa, @tk, @url, @obs, @uid, @unome) RETURNING id`,
        { cid: conviteId, tipo, causa, tk: ticketId, url: ticketUrl, obs: observacao, uid: user.ID, unome: trim(user.NOME) || trim(user.EMAIL) });

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

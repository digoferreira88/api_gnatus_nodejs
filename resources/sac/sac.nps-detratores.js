// GET /sac/nps/detratores?inicio=&fim=&comAcao=  — lista detratores com as
// respostas e as ações já tomadas. Perm 6003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6003]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/nps/detratores',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const conds = ["c.classificacao = 'DETRATOR'"], p = {};
    if (trim(req.query.inicio)) { conds.push('c.respondido_em >= @inicio'); p.inicio = trim(req.query.inicio); }
    if (trim(req.query.fim))    { conds.push('c.respondido_em < (@fim::date + 1)'); p.fim = trim(req.query.fim); }

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT c.id, c.pedido, c.cliente_cod, c.cliente_loja, c.cliente_nome, c.cnpj, c.telefone,
               c.nf, c.valor_pedido, c.nota_nps, c.respondido_em,
               (SELECT COUNT(*) FROM tab_nps_acao a WHERE a.convite_id = c.id) qtd_acoes
          FROM tab_nps_convite c
         WHERE ${conds.join(' AND ')}
         ORDER BY c.respondido_em DESC LIMIT 1000`, p);

      const ids = rows.map(r => r.id);
      const respPorConv = new Map(), acoesPorConv = new Map();
      if (ids.length) {
        const inIds = ids.map((_, i) => `@i${i}`).join(',');
        const pi = {}; ids.forEach((id, i) => { pi[`i${i}`] = id; });
        const resp = await Pg.connectAndQuery(
          `SELECT convite_id, pergunta_texto, tipo, nota, texto, opcao FROM tab_nps_resposta WHERE convite_id IN (${inIds}) ORDER BY id`, pi);
        resp.forEach(r => {
          if (!respPorConv.has(r.convite_id)) respPorConv.set(r.convite_id, []);
          respPorConv.get(r.convite_id).push({ pergunta: trim(r.pergunta_texto), tipo: trim(r.tipo), nota: r.nota, texto: trim(r.texto), opcao: trim(r.opcao) });
        });
        const acoes = await Pg.connectAndQuery(
          `SELECT convite_id, tipo, octadesk_ticket_id, octadesk_url, observacao, usuario_nome, criado_em FROM tab_nps_acao WHERE convite_id IN (${inIds}) ORDER BY criado_em DESC`, pi);
        acoes.forEach(a => {
          if (!acoesPorConv.has(a.convite_id)) acoesPorConv.set(a.convite_id, []);
          acoesPorConv.get(a.convite_id).push({ tipo: trim(a.tipo), ticketId: trim(a.octadesk_ticket_id), url: trim(a.octadesk_url), observacao: trim(a.observacao), usuario: trim(a.usuario_nome), criadoEm: a.criado_em });
        });
      }

      return res.json({
        detratores: rows.map(r => ({
          id: r.id, pedido: trim(r.pedido),
          clienteCod: trim(r.cliente_cod), clienteLoja: trim(r.cliente_loja), clienteNome: trim(r.cliente_nome),
          cnpj: trim(r.cnpj), telefone: trim(r.telefone), nf: trim(r.nf), valorPedido: N(r.valor_pedido),
          notaNps: r.nota_nps, respondidoEm: r.respondido_em, qtdAcoes: N(r.qtd_acoes),
          respostas: respPorConv.get(r.id) || [], acoes: acoesPorConv.get(r.id) || []
        })),
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('sac/nps-detratores:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

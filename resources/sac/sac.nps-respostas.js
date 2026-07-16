// GET /sac/nps/respostas?inicio=&fim=&classificacao=&formato=csv
// Registro das pesquisas RESPONDIDAS com todos os campos pedidos pelo CX:
// nome do cliente, empresa, CPF/CNPJ, produto adquirido, vendedor, data do
// faturamento, data da resposta, classificação + as respostas do formulário
// (1 coluna por pergunta ativa). formato=csv exporta. Perm 6003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6003]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const fd = (s) => { const x = trim(s); return x.length === 8 ? `${x.slice(6, 8)}/${x.slice(4, 6)}/${x.slice(0, 4)}` : ''; };
const csvCell = (v) => { const s = String(v == null ? '' : v).replace(/"/g, '""'); return /[",;\n]/.test(s) ? `"${s}"` : s; };

module.exports = (app) => ({
  verb: 'get',
  route: '/nps/respostas',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const conds = ["c.status = 'RESPONDIDO'"], p = {};
    if (trim(req.query.inicio)) { conds.push('c.respondido_em >= @inicio'); p.inicio = trim(req.query.inicio); }
    if (trim(req.query.fim))    { conds.push('c.respondido_em < (@fim::date + 1)'); p.fim = trim(req.query.fim); }
    if (trim(req.query.classificacao)) { conds.push('c.classificacao = @cls'); p.cls = trim(req.query.classificacao).toUpperCase(); }

    try {
      const convites = await Pg.connectAndQuery(`
        SELECT c.id, c.pedido, c.cliente_cod, c.cliente_loja, c.cliente_nome, c.empresa, c.cnpj,
               c.produto_desc, c.vendedor_nome, c.bu_nome, c.data_faturamento, c.respondido_em,
               c.classificacao, c.nota_nps
          FROM tab_nps_convite c
         WHERE ${conds.join(' AND ')}
         ORDER BY c.respondido_em DESC LIMIT 5000`, p);

      // perguntas ativas (colunas do formulário) + respostas
      const perguntas = await Pg.connectAndQuery(
        `SELECT id, ordem, texto FROM tab_nps_pergunta WHERE ativa ORDER BY ordem, id`, {});
      const respPorConv = new Map();
      if (convites.length) {
        const ids = convites.map(c => c.id);
        const inIds = ids.map((_, i) => `@i${i}`).join(',');
        const pi = {}; ids.forEach((id, i) => { pi[`i${i}`] = id; });
        const resp = await Pg.connectAndQuery(
          `SELECT convite_id, pergunta_id, nota, texto, opcao FROM tab_nps_resposta WHERE convite_id IN (${inIds})`, pi);
        resp.forEach(r => {
          if (!respPorConv.has(r.convite_id)) respPorConv.set(r.convite_id, {});
          respPorConv.get(r.convite_id)[r.pergunta_id] = trim(r.opcao) || trim(r.texto) || (r.nota != null ? String(r.nota) : '');
        });
      }

      const linhas = convites.map(c => {
        const rmap = respPorConv.get(c.id) || {};
        return {
          pedido: trim(c.pedido),
          clienteNome: trim(c.cliente_nome), clienteCod: trim(c.cliente_cod), clienteLoja: trim(c.cliente_loja),
          empresa: trim(c.empresa), cnpj: trim(c.cnpj), produto: trim(c.produto_desc), vendedor: trim(c.vendedor_nome),
          bu: trim(c.bu_nome), dataFaturamento: fd(c.data_faturamento), respondidoEm: c.respondido_em,
          classificacao: trim(c.classificacao), notaNps: c.nota_nps,
          respostas: perguntas.map(q => ({ pergunta: trim(q.texto), resposta: rmap[q.id] || '' }))
        };
      });

      if (trim(req.query.formato).toLowerCase() === 'csv') {
        const head = ['Data resposta', 'Data faturamento', 'Nome do cliente', 'Empresa', 'CPF/CNPJ', 'Produto adquirido',
          'Vendedor', 'BU', 'Pedido', 'Classificação', 'Nota', ...perguntas.map(q => trim(q.texto))];
        const rows = linhas.map(l => [
          l.respondidoEm ? new Date(l.respondidoEm).toLocaleString('pt-BR') : '',
          l.dataFaturamento, l.clienteNome, l.empresa, l.cnpj, l.produto, l.vendedor, l.bu, l.pedido,
          l.classificacao, l.notaNps == null ? '' : l.notaNps, ...l.respostas.map(r => r.resposta)
        ].map(csvCell).join(';'));
        const csv = '﻿' + [head.join(';'), ...rows].join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="nps-respostas-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.send(csv);
      }

      return res.json({ total: linhas.length, perguntas: perguntas.map(q => trim(q.texto)), respostas: linhas, geradoEm: new Date().toISOString() });
    } catch (err) {
      console.error('sac/nps-respostas:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

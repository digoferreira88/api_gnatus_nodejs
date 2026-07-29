// GET /fiscal/nfse/emitidas?inicio=&fim=&status=&ambiente=
// Histórico de emissões de NFS-e (tab_nfse_emitida), sem os XMLs grandes (baixe
// pelo /fiscal/nfse/xml). Perm 16001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const { config } = require('../../services/nfseEmissao');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/nfse/emitidas',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const hoje = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const inicio = trim(req.query.inicio) || ymd(new Date(hoje.getTime() - 30 * 864e5));
    const fim = trim(req.query.fim) || ymd(hoje);
    const status = trim(req.query.status);
    const ambiente = trim(req.query.ambiente) || config().ambienteRotulo;

    const cond = [`ambiente = @amb`, `criado_em >= @ini::timestamptz`, `criado_em < ((@fim)::date + 1)`];
    const params = { amb: ambiente, ini: inicio, fim };
    if (status) { cond.push(`status = @st`); params.st = status; }

    let rows;
    try {
      rows = await Pg.connectAndQuery(`
        SELECT id, serie, doc, cliente, loja, cliente_nome, valor, ctribnac, ambiente,
               status, nfse_chave, nfse_numero, dps_id, writeback, erros,
               (dps_xml IS NOT NULL) AS tem_dps, (nfse_xml IS NOT NULL) AS tem_nfse,
               emitido_por, emitido_em, criado_em
          FROM tab_nfse_emitida
         WHERE ${cond.join(' AND ')}
         ORDER BY criado_em DESC LIMIT 1000`, params);
    } catch (e) {
      return res.status(500).json({ message: 'Erro ao ler emissões: ' + e.message });
    }

    const docs = rows.map((r) => ({
      id: r.id, serie: trim(r.serie), doc: trim(r.doc), cliente: trim(r.cliente), loja: trim(r.loja),
      clienteNome: trim(r.cliente_nome), valor: Number(r.valor || 0), ctribnac: trim(r.ctribnac),
      ambiente: trim(r.ambiente), status: trim(r.status), chave: trim(r.nfse_chave),
      numero: trim(r.nfse_numero), dpsId: trim(r.dps_id), writeback: trim(r.writeback),
      erros: r.erros || [], temDps: !!r.tem_dps, temNfse: !!r.tem_nfse,
      emitidoPor: trim(r.emitido_por),
      emitidoEm: r.emitido_em ? new Date(r.emitido_em).toISOString() : '',
      criadoEm: r.criado_em ? new Date(r.criado_em).toISOString() : ''
    }));

    const kpis = {
      total: docs.length,
      emitidas: docs.filter((d) => d.status === 'EMITIDA').length,
      rejeitadas: docs.filter((d) => d.status === 'REJEITADA').length,
      erros: docs.filter((d) => d.status === 'ERRO').length,
      valorEmitido: +docs.filter((d) => d.status === 'EMITIDA').reduce((s, d) => s + d.valor, 0).toFixed(2)
    };

    return res.json({ periodo: { inicio, fim }, ambiente, kpis, docs });
  }
});

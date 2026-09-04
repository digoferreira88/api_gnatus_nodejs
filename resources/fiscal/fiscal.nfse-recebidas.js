// GET /fiscal/nfse-recebidas?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&situacao=&direcao=&pendentes=
// Pendências de NFS-e (notas de SERVIÇO) — a Gnatus como TOMADORA, puxadas do
// Ambiente de Dados Nacional (ADN) da NFS-e Padrão Nacional (tab_nfse_recebida,
// alimentada por services/nfseDistribuicaoAdn.js). É o análogo da aba
// "Pendências (SEFAZ)" (que é de NF-e). Substitui a visão que o Transmite
// deixou de entregar. Perm 16001.
//
// Pendência aqui é workflow MANUAL: nota nasce PENDENTE e o fiscal marca
// CONFERIDA quando escritura/confere (POST .../conferir). Não há cruzamento
// automático com o Protheus (NFS-e de entrada não tem chave na SF1010 como a NF-e).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/nfse-recebidas',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;

    const hoje = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const inicio = trim(req.query.inicio) || ymd(new Date(hoje.getFullYear(), hoje.getMonth() - 2, 1)); // 3 meses
    const fim = trim(req.query.fim) || ymd(hoje);
    const fSituacao = trim(req.query.situacao).toUpperCase();     // PENDENTE | CONFERIDA
    const direcao = trim(req.query.direcao) || 'recebida';        // recebida (default) | emitida | todas
    const soPendentes = ['1', 'true', 'sim'].includes(trim(req.query.pendentes).toLowerCase());

    let rows;
    try {
      rows = await Pg.connectAndQuery(`
        SELECT chave, nsu, tipo_doc, numero, serie, emit_cnpj, emit_nome, emit_mun_nome, emit_uf,
               toma_cnpj, toma_nome, direcao, valor, valor_iss, aliq, desc_servico,
               dh_emi, competencia, cstat, situacao, conferido_em, criado_em
          FROM tab_nfse_recebida
         WHERE (@dir = 'todas' OR direcao = @dir)
           AND COALESCE(dh_emi, criado_em) >= @ini::timestamptz
           AND COALESCE(dh_emi, criado_em) < ((@fim)::date + 1)
         ORDER BY COALESCE(dh_emi, criado_em) DESC`,
        { dir: direcao, ini: inicio, fim });
    } catch (e) {
      console.error('Erro NFS-e recebidas (tab_nfse_recebida):', e.message);
      return res.status(500).json({ message: 'Erro ao ler NFS-e recebidas: ' + e.message });
    }

    let docs = rows.map((n) => ({
      chave: trim(n.chave),
      nsu: N(n.nsu),
      tipoDoc: trim(n.tipo_doc) || 'NFSE',
      numero: trim(n.numero),
      serie: trim(n.serie),
      emissor: trim(n.emit_nome),
      cnpjEmi: trim(n.emit_cnpj),
      municipio: [trim(n.emit_mun_nome), trim(n.emit_uf)].filter(Boolean).join('/'),
      tomador: trim(n.toma_nome),
      cnpjToma: trim(n.toma_cnpj),
      direcao: trim(n.direcao),
      valor: N(n.valor),
      valorIss: N(n.valor_iss),
      aliq: N(n.aliq),
      servico: trim(n.desc_servico),
      emissao: n.dh_emi ? new Date(n.dh_emi).toISOString() : '',
      competencia: n.competencia ? new Date(n.competencia).toISOString().slice(0, 10) : '',
      cstat: trim(n.cstat),
      situacao: trim(n.situacao) || 'PENDENTE',
      conferidoEm: n.conferido_em ? new Date(n.conferido_em).toISOString() : '',
      recebimento: n.criado_em ? new Date(n.criado_em).toISOString() : '',
      pendente: (trim(n.situacao) || 'PENDENTE') === 'PENDENTE'
    }));

    if (fSituacao) docs = docs.filter((d) => d.situacao === fSituacao);
    if (soPendentes) docs = docs.filter((d) => d.pendente);

    const cur = await Pg.connectAndQuery(
      `SELECT ult_nsu, max_nsu, atualizado_em FROM tab_nfse_adn_nsu ORDER BY atualizado_em DESC LIMIT 1`, {})
      .catch(() => []);

    const kpis = {
      total: docs.length,
      pendentes: docs.filter((d) => d.pendente).length,
      conferidas: docs.filter((d) => !d.pendente).length,
      valorTotal: +docs.reduce((s, d) => s + d.valor, 0).toFixed(2),
      valorPendente: +docs.filter((d) => d.pendente).reduce((s, d) => s + d.valor, 0).toFixed(2),
      valorIss: +docs.reduce((s, d) => s + d.valorIss, 0).toFixed(2)
    };

    return res.json({
      periodo: { inicio, fim },
      filtros: { situacao: fSituacao, direcao, soPendentes },
      fonte: 'ADN NFS-e (Distribuição de DF-e — Padrão Nacional)',
      cursor: cur.length ? { ultNSU: N(cur[0].ult_nsu), maxNSU: N(cur[0].max_nsu), atualizadoEm: cur[0].atualizado_em } : null,
      kpis,
      docs,
      geradoEm: new Date().toISOString()
    });
  }
});

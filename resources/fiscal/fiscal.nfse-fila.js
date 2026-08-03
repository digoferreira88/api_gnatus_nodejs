// GET /fiscal/nfse/fila?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&pendentes=1
// Fila de emissão de NFS-e: lista as NF de serviço (SF2 série C) do período e
// cruza com tab_nfse_emitida pra mostrar o status (NAO_EMITIDA / EMITIDA /
// REJEITADA / ERRO / PENDENTE). Perm 16001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const { listarNotasServicoPeriodo, dataIso } = require('../../services/nfseProtheus');
const { config } = require('../../services/nfseEmissao');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/nfse/fila',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;
    const hoje = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const inicio = trim(req.query.inicio) || ymd(new Date(hoje.getTime() - 30 * 864e5));
    const fim = trim(req.query.fim) || ymd(hoje);
    const soPendentes = ['1', 'true', 'sim'].includes(trim(req.query.pendentes).toLowerCase());
    const { ambienteRotulo } = config();

    // NF de serviço do período (Protheus usa YYYYMMDD)
    let notas;
    try {
      notas = await listarNotasServicoPeriodo(Protheus, {
        serie: 'C', inicio: inicio.replace(/-/g, ''), fim: fim.replace(/-/g, '')
      });
    } catch (e) {
      return res.status(500).json({ message: 'Erro ao ler NF de serviço no Protheus: ' + e.message });
    }

    // nomes dos clientes (batch SA1)
    const chavesCli = [...new Set(notas.map((n) => `${trim(n.cliente)}|${trim(n.loja)}`))];
    const nomes = new Map();
    if (chavesCli.length) {
      const ors = chavesCli.map((_, i) => `(A1_COD=@c${i} AND A1_LOJA=@l${i})`).join(' OR ');
      const p = {};
      chavesCli.forEach((k, i) => { const [c, l] = k.split('|'); p[`c${i}`] = c; p[`l${i}`] = l; });
      try {
        const sa1 = await Protheus.connectAndQuery(
          `SELECT RTRIM(A1_COD) cod, RTRIM(A1_LOJA) loja, RTRIM(A1_NOME) nome
             FROM SA1010 WITH (NOLOCK) WHERE D_E_L_E_T_<>'*' AND (${ors})`, p);
        sa1.forEach((s) => nomes.set(`${trim(s.cod)}|${trim(s.loja)}`, trim(s.nome)));
      } catch (e) { /* nome é cosmético */ }
    }

    // status já emitido (nesse ambiente)
    let emit = [];
    try {
      emit = await Pg.connectAndQuery(
        `SELECT doc, cliente, loja, status, nfse_chave, ctribnac
           FROM tab_nfse_emitida WHERE ambiente=@amb AND serie='C'`, { amb: ambienteRotulo });
    } catch (e) {
      return res.status(500).json({ message: 'Erro ao ler emissões: ' + e.message });
    }
    const mapEmit = new Map(emit.map((e) => [`${trim(e.doc)}|${trim(e.cliente)}|${trim(e.loja)}`, e]));

    // Corte de emissão (YYYYMMDD): NF de serviço faturada ANTES desta data e sem
    // registro de emissão = LEGADA (a NFS-e já foi feita MANUALMENTE no portal antes
    // da automação). Não são re-emitíveis pela intranet — re-emitir duplicaria a nota
    // real no Barretos. Sem a env, ninguém vira LEGADA (comportamento original).
    const corte = trim(process.env.NFSE_EMISSAO_CORTE).replace(/\D/g, '');
    let docs = notas.map((n) => {
      const doc = trim(n.doc), cli = trim(n.cliente), loja = trim(n.loja);
      const e = mapEmit.get(`${doc}|${cli}|${loja}`);
      const emiRaw = trim(n.emissao).replace(/\D/g, '').slice(0, 8);
      const status = e ? e.status : (corte && emiRaw && emiRaw < corte ? 'LEGADA' : 'NAO_EMITIDA');
      return {
        doc, serie: trim(n.serie), cliente: cli, loja,
        clienteNome: nomes.get(`${cli}|${loja}`) || '',
        emissao: dataIso(n.emissao), valor: N(n.valbrut),
        status,
        chave: e ? trim(e.nfse_chave) : '',
        ctribnac: e ? trim(e.ctribnac) : ''
      };
    });
    if (soPendentes) docs = docs.filter((d) => d.status !== 'EMITIDA' && d.status !== 'LEGADA');

    const kpis = {
      total: docs.length,
      naoEmitidas: docs.filter((d) => d.status === 'NAO_EMITIDA').length,
      emitidas: docs.filter((d) => d.status === 'EMITIDA').length,
      rejeitadas: docs.filter((d) => d.status === 'REJEITADA' || d.status === 'ERRO').length,
      legadas: docs.filter((d) => d.status === 'LEGADA').length,
      valorTotal: +docs.reduce((s, d) => s + d.valor, 0).toFixed(2)
    };

    return res.json({
      periodo: { inicio, fim }, ambiente: ambienteRotulo, kpis,
      docs: docs.sort((a, b) => (b.emissao || '').localeCompare(a.emissao || '')),
      geradoEm: new Date().toISOString()
    });
  }
});

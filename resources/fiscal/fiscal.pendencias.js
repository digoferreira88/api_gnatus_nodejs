// GET /fiscal/pendencias?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&situacao=&pendentes=
// Monitoramento de Pendências (visão 3) — NF-e RECEBIDAS no TOTVS Transmite,
// cruzadas contra a SF1010 do Protheus pela Chave: a nota cuja chave NÃO está
// escriturada (não existe em F1_CHVNFE) é "Pendente de escrituração".
// Fonte de verdade dos recebimentos = Transmite (não o Protheus). Perm 16001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const Transmite = require('../../services/transmite');
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

// CStat (status SEFAZ) -> situação amigável
const situacaoPorCStat = (c) => {
  c = trim(c);
  if (['100', '150'].includes(c)) return 'Autorizada';
  if (['101', '151', '155'].includes(c)) return 'Cancelada';
  if (['110', '301', '302', '303'].includes(c)) return 'Denegada';
  return c ? `Outros (${c})` : 'Indefinida';
};
// IntegracaoERP: 1 = Exportada p/ ERP (conforme painel); demais = não exportada
const integracaoLabel = (v) => (Number(v) === 1 ? 'Exportada' : 'Não exportada');

module.exports = (app) => ({
  verb: 'get',
  route: '/pendencias',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    if (!(await Transmite.disponivel())) {
      return res.status(503).json({ message: 'Integração TOTVS Transmite não configurada — cadastre o token na tela "Token Transmite".' });
    }

    // período padrão: mês corrente
    const hoje = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const inicio = trim(req.query.inicio) || ymd(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    const fim = trim(req.query.fim) || ymd(hoje);
    const fSituacao = trim(req.query.situacao);                 // Autorizada | Cancelada | Denegada
    const soPendentes = ['1', 'true', 'sim'].includes(trim(req.query.pendentes).toLowerCase());

    let recebidas;
    try {
      recebidas = await Transmite.listarRecebidas(inicio, fim);
    } catch (e) {
      console.error('Erro Transmite:', e.message);
      return res.status(e.status === 401 ? 401 : 502).json({ message: e.message });
    }

    // cruza com SF1010 (escrituradas) pela chave
    const chaves = [...new Set(recebidas.map((n) => trim(n.Chave).replace(/\D/g, '')).filter((c) => c.length === 44))];
    const escrituradas = new Set();
    try {
      for (let i = 0; i < chaves.length; i += 500) {
        const lote = chaves.slice(i, i + 500).map((c) => `'${c}'`).join(',');
        if (!lote) continue;
        const rows = await Protheus.connectAndQuery(
          `SELECT RTRIM(F1_CHVNFE) chv FROM SF1010 WITH (NOLOCK)
            WHERE D_E_L_E_T_<>'*' AND RTRIM(F1_CHVNFE) IN (${lote})`, {});
        rows.forEach((r) => escrituradas.add(trim(r.chv)));
      }
    } catch (err) {
      console.error('Erro cruzamento SF1010:', err);
      return res.status(500).json({ message: 'Erro ao cruzar com Protheus: ' + err.message });
    }

    let docs = recebidas.map((n) => {
      const chave = trim(n.Chave);
      const escriturada = escrituradas.has(chave.replace(/\D/g, ''));
      return {
        chave,
        numero: trim(n.Numero),
        serie: trim(n.Serie),
        emissor: trim(n.Emissor),
        cnpjEmi: trim(n.CnpjCpfEmi),
        valor: N(n.VNf),
        emissao: trim(n.DhEmi),
        recebimento: trim(n.DhRecbto),
        cstat: trim(n.CStat),
        situacao: situacaoPorCStat(n.CStat),
        manifestacao: trim(n.SituacaoMDe && n.SituacaoMDe.StatusManifestacao),
        integracaoERP: integracaoLabel(n.IntegracaoERP),
        integracaoCod: Number(n.IntegracaoERP),
        natOp: trim(n.NatOp),
        escriturada,
        pendente: !escriturada
      };
    });

    if (fSituacao) docs = docs.filter((d) => d.situacao === fSituacao);
    if (soPendentes) docs = docs.filter((d) => d.pendente);

    const kpis = {
      total: docs.length,
      pendentes: docs.filter((d) => d.pendente).length,
      escrituradas: docs.filter((d) => !d.pendente).length,
      autorizadas: docs.filter((d) => d.situacao === 'Autorizada').length,
      canceladas: docs.filter((d) => d.situacao === 'Cancelada').length,
      denegadas: docs.filter((d) => d.situacao === 'Denegada').length,
      valorTotal: +docs.reduce((s, d) => s + d.valor, 0).toFixed(2),
      valorPendente: +docs.filter((d) => d.pendente).reduce((s, d) => s + d.valor, 0).toFixed(2)
    };

    return res.json({
      periodo: { inicio, fim },
      filtros: { situacao: fSituacao, soPendentes },
      kpis,
      docs: docs.sort((a, b) => (b.emissao || '').localeCompare(a.emissao || '')),
      geradoEm: new Date().toISOString()
    });
  }
});

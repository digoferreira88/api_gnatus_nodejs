// GET /fiscal/pendencias?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&situacao=&pendentes=
// Monitoramento de Pendências (visão 3) — NF-e RECEBIDAS direto da SEFAZ
// (tab_dfe_recebida, alimentada por services/sefazDfe.js via NFeDistribuicaoDFe),
// cruzadas contra a SF1010 do Protheus pela chave: a nota cuja chave NÃO está
// escriturada (não existe em F1_CHVNFE) é "Pendente de escrituração". Perm 16001.
//
// (28/07/2026) Fonte migrada de TOTVS Transmite → SEFAZ direto (mTLS A1). Mesmo
// formato de resposta. Campos sem equivalente no DF-e (manifestação/integraçãoERP)
// ficam neutros.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

// situação SEFAZ. resNFe usa cSitNFe (1=Autorizada, 2=Denegada, 3=Cancelada);
// procNFe/protNFe usam cStat (100/150=Autorizada, 101/151/155=Cancelada...).
const situacaoPorCStat = (c) => {
  c = trim(c);
  if (['1', '100', '150'].includes(c)) return 'Autorizada';
  if (['3', '101', '151', '155'].includes(c)) return 'Cancelada';
  if (['2', '110', '301', '302', '303'].includes(c)) return 'Denegada';
  return c ? `Outros (${c})` : 'Indefinida';
};
// número/série extraídos da chave de acesso (44 díg): série [22..25), nNF [25..34).
const serieDaChave = (ch) => ch.length === 44 ? String(Number(ch.slice(22, 25))) : '';
const numeroDaChave = (ch) => ch.length === 44 ? String(Number(ch.slice(25, 34))) : '';

module.exports = (app) => ({
  verb: 'get',
  route: '/pendencias',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;

    // período padrão: mês corrente
    const hoje = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const inicio = trim(req.query.inicio) || ymd(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    const fim = trim(req.query.fim) || ymd(hoje);
    const fSituacao = trim(req.query.situacao);                 // Autorizada | Cancelada | Denegada
    const soPendentes = ['1', 'true', 'sim'].includes(trim(req.query.pendentes).toLowerCase());

    // recebidas = NF-e do DF-e (1 linha por chave, o doc mais recente), no período (dh_emi)
    let recebidas;
    try {
      recebidas = await Pg.connectAndQuery(`
        SELECT DISTINCT ON (chave) chave, cnpj_emit, nome_emit, valor, dh_emi, cstat, criado_em
          FROM tab_dfe_recebida
         WHERE chave IS NOT NULL AND chave <> '' AND schema_dfe NOT ILIKE '%evento%'
           AND dh_emi >= @ini::timestamptz AND dh_emi < ((@fim)::date + 1)
         ORDER BY chave, nsu DESC`, { ini: inicio, fim });
    } catch (e) {
      console.error('Erro DF-e (tab_dfe_recebida):', e.message);
      return res.status(500).json({ message: 'Erro ao ler recebidas (DF-e): ' + e.message });
    }

    // cruza com SF1010 (escrituradas) pela chave
    const chaves = [...new Set(recebidas.map((n) => trim(n.chave).replace(/\D/g, '')).filter((c) => c.length === 44))];
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
      const chave = trim(n.chave);
      const escriturada = escrituradas.has(chave.replace(/\D/g, ''));
      return {
        chave,
        numero: numeroDaChave(chave),
        serie: serieDaChave(chave),
        emissor: trim(n.nome_emit),
        cnpjEmi: trim(n.cnpj_emit),
        valor: N(n.valor),
        emissao: n.dh_emi ? new Date(n.dh_emi).toISOString() : '',
        recebimento: n.criado_em ? new Date(n.criado_em).toISOString() : '',
        cstat: trim(n.cstat),
        situacao: situacaoPorCStat(n.cstat),
        manifestacao: '',                 // não disponível no DF-e (era campo do Transmite)
        integracaoERP: '—',
        integracaoCod: null,
        natOp: '',
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
      fonte: 'SEFAZ DF-e (NFeDistribuicaoDFe)',
      kpis,
      docs: docs.sort((a, b) => (b.emissao || '').localeCompare(a.emissao || '')),
      geradoEm: new Date().toISOString()
    });
  }
});

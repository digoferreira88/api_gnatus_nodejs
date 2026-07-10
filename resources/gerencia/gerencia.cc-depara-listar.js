// GET /gerencia/cc-depara — lista o de-para fornecedor -> centro de custo usado
// pelo DRE por CC pra atribuir títulos diretos do financeiro (FINA050) sem CC.
// Enriquece com nome do fornecedor (SA2) e descrição do CC (CTT) best-effort.
// Perm 10001 (mesma do DRE).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10001]);
const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/cc-depara',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    try {
      const rows = await Pg.connectAndQuery(`
        SELECT d.id, d.fornece, d.loja, d.cc, d.observacao, d.atualizado_em, u.nome AS atualizado_por_nome
          FROM tab_cc_fornecedor_depara d
          LEFT JOIN tab_intranet_usr u ON u.id = d.atualizado_por
         ORDER BY d.fornece, d.loja`, {});

      // Enriquecimento best-effort (nomes)
      const nomes = new Map(); const ccDesc = new Map();
      if (rows.length) {
        try {
          const forns = [...new Set(rows.map(r => trim(r.fornece)))];
          const p = {}; const inF = forns.map((f, i) => { p[`f${i}`] = f; return `@f${i}`; }).join(',');
          const sa2 = await Protheus.connectAndQuery(
            `SELECT RTRIM(A2_COD) cod, RTRIM(A2_LOJA) loja, RTRIM(COALESCE(A2_NREDUZ, A2_NOME)) nome
               FROM SA2010 WITH (NOLOCK) WHERE D_E_L_E_T_ <> '*' AND A2_COD IN (${inF})`, p);
          sa2.forEach(s => { const k = trim(s.cod); if (!nomes.has(k)) nomes.set(k, trim(s.nome)); });

          const ccs = [...new Set(rows.map(r => trim(r.cc)))];
          const p2 = {}; const inC = ccs.map((c, i) => { p2[`c${i}`] = c; return `@c${i}`; }).join(',');
          const ctt = await Protheus.connectAndQuery(
            `SELECT RTRIM(CTT_CUSTO) cc, RTRIM(CTT_DESC01) descricao FROM CTT010 WITH (NOLOCK)
              WHERE D_E_L_E_T_ <> '*' AND CTT_CUSTO IN (${inC})`, p2);
          ctt.forEach(c => { if (!ccDesc.has(trim(c.cc))) ccDesc.set(trim(c.cc), trim(c.descricao)); });
        } catch (e) { console.warn('cc-depara listar: enriquecimento err:', e.message); }
      }

      return res.json(rows.map(r => ({
        id: r.id, fornece: trim(r.fornece), loja: trim(r.loja), cc: trim(r.cc),
        fornecedorNome: nomes.get(trim(r.fornece)) || '',
        ccDescricao: ccDesc.get(trim(r.cc)) || '',
        observacao: trim(r.observacao) || null,
        atualizadoPor: trim(r.atualizado_por_nome) || null,
        atualizadoEm: r.atualizado_em
      })));
    } catch (err) {
      console.error('gerencia/cc-depara listar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

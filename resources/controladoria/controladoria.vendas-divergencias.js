// GET /controladoria/vendas/divergencias?snapshot_mes=YYYYMM&mes=YYYYMM
// Cruza as NF FATURADAS de um mês (emissão) do snapshot com o Protheus (opção C).
// Só olha linhas com NF preenchida (faturado) — pedido ainda em pipeline (sem NF)
// não é divergência, é estado normal. Casa por NF (D2_DOC) contra o SD2 (NF de saída):
//   NF_CANCELADA     — NF sumiu do SD2 (invoice cancelada/apagada no ERP)
//   VALOR_DIVERGENTE — |total da planilha − total no ERP| > tolerância
// Audita um mês por vez. Perm 11006. (Devolução/BU detalhados = refinamento futuro.)

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11006, 0]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/vendas/divergencias',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const snap = /^\d{6}$/.test(String(req.query.snapshot_mes || '')) ? String(req.query.snapshot_mes) : null;
    const emis = /^\d{6}$/.test(String(req.query.mes || '')) ? String(req.query.mes) : null;
    if (!snap || !emis) return res.status(400).json({ message: 'snapshot_mes e mes (YYYYMM) são obrigatórios.' });

    try {
      // 1) por NF faturada do mês: total da planilha (SUM Total Item).
      const nfs = await Pg.connectAndQuery(`
        SELECT nf, MAX(pedido) pedido, MAX(cliente_nome) cliente, MAX(tipo_considerar) tipo_considerar,
               COALESCE(SUM(total_item), 0) total_plan
          FROM tab_ctrl_vendas_snapshot
         WHERE snapshot_mes = @snap AND to_char(emissao,'YYYYMM') = @emis
           AND nf IS NOT NULL AND nf <> ''
         GROUP BY nf`, { snap, emis });

      // 2) total faturado no ERP por NF (SD2.D2_DOC, D2_VALBRUT).
      const mapProt = new Map();
      const BATCH = 500;
      for (let i = 0; i < nfs.length; i += BATCH) {
        const slice = nfs.slice(i, i + BATCH);
        const inl = slice.map((_, k) => `@n${k}`).join(',');
        const params = {}; slice.forEach((r, k) => { params[`n${k}`] = trim(r.nf); });
        const rows = await Protheus.connectAndQuery(`
          SELECT RTRIM(D2_DOC) nf, SUM(D2_VALBRUT) total
            FROM SD2010 WITH (NOLOCK)
           WHERE D2_FILIAL = '01' AND D_E_L_E_T_ <> '*' AND RTRIM(D2_DOC) IN (${inl})
           GROUP BY D2_DOC`, params);
        rows.forEach(r => mapProt.set(trim(r.nf), r));
      }

      // 3) compara por NF. Tolerância = 1% ou R$ 1 (o maior).
      const divergencias = [];
      for (const r of nfs) {
        const nf = trim(r.nf);
        const pr = mapProt.get(nf);
        const totalPlan = N(r.total_plan);
        if (!pr) {
          divergencias.push({ nf, pedido: trim(r.pedido), tipo: 'NF_CANCELADA', cliente: trim(r.cliente),
            tipo_considerar: trim(r.tipo_considerar), total_plan: totalPlan, total_protheus: null, diff: null });
          continue;
        }
        const totalProt = N(pr.total);
        if (Math.abs(totalPlan - totalProt) > Math.max(1, totalPlan * 0.01)) {
          divergencias.push({ nf, pedido: trim(r.pedido), tipo: 'VALOR_DIVERGENTE', cliente: trim(r.cliente),
            tipo_considerar: trim(r.tipo_considerar), total_plan: totalPlan, total_protheus: totalProt, diff: totalProt - totalPlan });
        }
      }
      divergencias.sort((a, b) => (a.tipo === b.tipo ? Math.abs(N(b.diff)) - Math.abs(N(a.diff)) : (a.tipo === 'NF_CANCELADA' ? -1 : 1)));

      return res.json({
        snapshotMes: snap, mes: emis, nfsFaturadasAuditadas: nfs.length,
        resumo: {
          nfCancelada: divergencias.filter(d => d.tipo === 'NF_CANCELADA').length,
          valorDivergente: divergencias.filter(d => d.tipo === 'VALOR_DIVERGENTE').length
        },
        divergencias: divergencias.slice(0, 500),
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('controladoria/vendas-divergencias:', err);
      return res.status(500).json({ message: 'Erro ao cruzar com o Protheus.' });
    }
  }
});

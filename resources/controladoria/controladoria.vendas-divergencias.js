// GET /controladoria/vendas/divergencias?snapshot_mes=YYYYMM&mes=YYYYMM
// Cruza os pedidos de UM mês (emissão) do snapshot com o Protheus (opção C): flaga
// pedido EXCLUÍDO (sumiu do SC5 ativo) e VALOR DIVERGENTE (total da planilha ≠ total
// do pedido no ERP). Audita um mês por vez pra limitar a consulta ao ERP. Perm 11006.
// (BU e devolução detalhada = refinamentos futuros — o C5_ZTIPO do ERP vai no retorno.)

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
      // 1) pedidos do mês (emissão) no snapshot — total do pedido = valor da seq 01.
      const peds = await Pg.connectAndQuery(`
        SELECT pedido, MAX(total_pedido) total_plan, MAX(tipo) tipo,
               MAX(tipo_considerar) tipo_considerar, MAX(cliente_nome) cliente
          FROM tab_ctrl_vendas_snapshot
         WHERE snapshot_mes = @snap AND to_char(emissao,'YYYYMM') = @emis AND pedido <> ''
         GROUP BY pedido`, { snap, emis });

      // 2) cruza com o Protheus em batches (SC5 ativo + total do pedido).
      const mapProt = new Map();
      const BATCH = 500;
      for (let i = 0; i < peds.length; i += BATCH) {
        const slice = peds.slice(i, i + BATCH);
        const inl = slice.map((_, k) => `@p${k}`).join(',');
        const params = {}; slice.forEach((p, k) => { params[`p${k}`] = trim(p.pedido); });
        const rows = await Protheus.connectAndQuery(`
          SELECT RTRIM(sc5.C5_NUM) pedido, RTRIM(sc5.C5_ZTIPO) bu,
                 CAST(ISNULL(tp.total, 0) AS NUMERIC(15,2)) total
            FROM SC5010 sc5 WITH (NOLOCK)
            LEFT JOIN total_pedido_sc6 tp WITH (NOLOCK) ON tp.c6_num = sc5.C5_NUM
           WHERE sc5.C5_FILIAL = '01' AND sc5.D_E_L_E_T_ <> '*' AND RTRIM(sc5.C5_NUM) IN (${inl})`, params);
        rows.forEach(r => mapProt.set(trim(r.pedido), r));
      }

      // 3) compara. Tolerância = 0,5% do valor ou R$ 1 (o que for maior).
      const divergencias = [];
      for (const p of peds) {
        const ped = trim(p.pedido);
        const pr = mapProt.get(ped);
        const totalPlan = N(p.total_plan);
        if (!pr) {
          divergencias.push({ pedido: ped, tipo: 'EXCLUIDO', cliente: trim(p.cliente), tipo_considerar: trim(p.tipo_considerar),
            total_plan: totalPlan, total_protheus: null, diff: null, bu_protheus: null });
          continue;
        }
        const totalProt = N(pr.total);
        const tol = Math.max(1, totalPlan * 0.005);
        if (Math.abs(totalPlan - totalProt) > tol) {
          divergencias.push({ pedido: ped, tipo: 'VALOR_DIVERGENTE', cliente: trim(p.cliente), tipo_considerar: trim(p.tipo_considerar),
            total_plan: totalPlan, total_protheus: totalProt, diff: totalProt - totalPlan, bu_protheus: trim(pr.bu) });
        }
      }
      divergencias.sort((a, b) => Math.abs(N(b.diff)) - Math.abs(N(a.diff)));

      return res.json({
        snapshotMes: snap, mes: emis, pedidosAuditados: peds.length,
        resumo: {
          excluidos: divergencias.filter(d => d.tipo === 'EXCLUIDO').length,
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

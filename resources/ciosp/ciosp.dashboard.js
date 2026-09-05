// GET /ciosp/dashboard?edicao=&dia=YYYY-MM-DD
// Agrega as vendas do CIOSP (tab_ciosp_venda) em todos os visuais do painel que
// substitui o Power BI: KPIs, metas, gerentes, rankings (presencial/online/
// digital/AT), origem, formas de pagamento e pré-aprovadas. Filtro "dia do
// evento" opcional. Perm 19001. Só leitura do Postgres.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19001, 0]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const r2 = (v) => +Number(v || 0).toFixed(2);

// agrupa linhas por chave -> [{ nome, total, qtd }] ordenado desc por total
function agrupar(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = trim(keyFn(r)) || '(Sem)';
    const cur = m.get(k) || { nome: k, total: 0, qtd: 0 };
    cur.total += N(r.valor); cur.qtd += 1;
    m.set(k, cur);
  }
  return [...m.values()].map(x => ({ ...x, total: r2(x.total) })).sort((a, b) => b.total - a.total);
}
const comPct = (arr, base) => arr.map(x => ({ ...x, pct: base > 0 ? r2(x.total / base * 100) : 0 }));

module.exports = (app) => ({
  verb: 'get',
  route: '/dashboard',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      // edição: a pedida, senão a com mais vendas
      let edicao = trim(req.query.edicao);
      const eds = await Pg.connectAndQuery(
        `SELECT edicao, COUNT(*) n FROM tab_ciosp_venda GROUP BY edicao ORDER BY n DESC`, {});
      const edicoes = eds.map(e => e.edicao);
      if (!edicao) edicao = edicoes[0] || 'CIOSP 2026';

      const dia = trim(req.query.dia);   // YYYY-MM-DD | ''

      const rows = await Pg.connectAndQuery(
        `SELECT categoria, cliente, vendedor, uf, pagto_princ, gerente, origem, equipe,
                valor, data_venda
           FROM tab_ciosp_venda
          WHERE edicao=@ed ${dia ? 'AND data_venda = @dia::date' : ''}`,
        dia ? { ed: edicao, dia } : { ed: edicao });

      // dias disponíveis (sempre da edição inteira, p/ o filtro não sumir)
      const diasRows = await Pg.connectAndQuery(
        `SELECT DISTINCT data_venda FROM tab_ciosp_venda
          WHERE edicao=@ed AND data_venda IS NOT NULL ORDER BY data_venda`, { ed: edicao });
      const dias = diasRows.map(d => new Date(d.data_venda).toISOString().slice(0, 10));

      const eq = rows.filter(r => r.categoria === 'EQUIPAMENTOS');
      const dg = rows.filter(r => r.categoria === 'DIGITAL');
      const at = rows.filter(r => r.categoria === 'AT');
      const soma = (a) => r2(a.reduce((s, r) => s + N(r.valor), 0));

      const totEquip = soma(eq), totDigital = soma(dg), totAt = soma(at);
      const totalGeral = r2(totEquip + totDigital + totAt);

      // metas
      const mrow = await Pg.connectAndQuery(`SELECT * FROM tab_ciosp_meta WHERE edicao=@e`, { e: edicao });
      const meta = mrow[0] || { meta_geral: 0, super_meta: 0, meta_equip: 0, meta_digital: 0, meta_at: 0 };

      const eqTot = totEquip;   // base dos visuais de equipamentos
      const presencial = eq.filter(r => /presencial/i.test(trim(r.origem)));
      const online = eq.filter(r => /online/i.test(trim(r.origem)));
      const totPres = soma(presencial), totOnl = soma(online);

      // formas de pagamento (equipamentos) — donut
      const pagamentos = comPct(agrupar(eq, r => r.pagto_princ), eqTot);

      // pré-aprovadas por categoria
      const preAprov = agrupar(rows.filter(r => /pr[eé].?aprov/i.test(trim(r.pagto_princ))), r => r.categoria)
        .map(x => ({ setor: x.nome, valor: x.total }));

      return res.json({
        edicao, edicoes, dia, dias,
        kpis: {
          vendasTotal: totalGeral,
          metaGeral: N(meta.meta_geral),
          superMeta: N(meta.super_meta),
          pctMetaGeral: N(meta.meta_geral) > 0 ? r2(totalGeral / N(meta.meta_geral) * 100) : 0,
          pctSuperMeta: N(meta.super_meta) > 0 ? r2(totalGeral / N(meta.super_meta) * 100) : 0,
          qtdVendas: rows.length
        },
        categorias: {
          equipamentos: totEquip, digital: totDigital, at: totAt,
          qtdEquip: eq.length, qtdDigital: dg.length, qtdAt: at.length
        },
        metas: {
          geral: N(meta.meta_geral), super: N(meta.super_meta),
          equip: N(meta.meta_equip), digital: N(meta.meta_digital), at: N(meta.meta_at)
        },
        gerentes: comPct(agrupar(eq, r => r.gerente), eqTot),           // pizza + tabela (equipamentos)
        rankingPresencial: agrupar(presencial, r => r.vendedor).slice(0, 6),
        rankingOnline: agrupar(online, r => r.vendedor).slice(0, 6),
        rankingDigital: agrupar(dg, r => r.vendedor).slice(0, 6),
        rankingAt: agrupar(at, r => r.vendedor).slice(0, 6),
        gerentesAt: agrupar(at, r => r.gerente),
        gerentesDigital: agrupar(dg, r => r.gerente),
        origem: {
          presencial: totPres, online: totOnl,
          pctPresencial: eqTot > 0 ? r2(totPres / eqTot * 100) : 0,
          pctOnline: eqTot > 0 ? r2(totOnl / eqTot * 100) : 0
        },
        pagamentos,
        preAprovadas: { itens: preAprov, total: r2(preAprov.reduce((s, x) => s + x.valor, 0)) },
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('ciosp/dashboard:', err.message);
      return res.status(500).json({ message: 'Erro ao montar dashboard CIOSP: ' + err.message });
    }
  }
});

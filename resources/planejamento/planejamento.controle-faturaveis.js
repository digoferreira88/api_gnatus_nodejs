// GET /planejamento/controle/faturaveis?mes=YYYYMM
// Pedidos com entrega ATÉ o fim do mês (atrasados + do mês) ainda NÃO no controle.
// Indicador de estoque por item (sem disputa entre pedidos). Permissão 3003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([3003]);
const { getCfops, inLista } = require('../vendas/_cfops');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const inStr = (arr) => arr.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',');

module.exports = (app) => ({
  verb: 'get',
  route: '/controle/faturaveis',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const hoje = new Date();
    const mes = /^\d{6}$/.test(trim(req.query.mes)) ? trim(req.query.mes) : `${hoje.getFullYear()}${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const fimMes = ymd(new Date(+mes.slice(0, 4), +mes.slice(4, 6), 0));

    try {
      const cfops = await getCfops(Pg, 'carteira');
      if (!cfops.length) return res.status(500).json({ message: 'CFOPs de carteira vazios.' });

      const jaControle = (await Pg.connectAndQuery(`SELECT pedido FROM tab_plan_controle WHERE filial='01'`, {})).map(r => trim(r.pedido));
      const notIn = jaControle.length ? `AND RTRIM(sc6.C6_NUM) NOT IN (${inStr(jaControle)})` : '';

      const rows = await Protheus.connectAndQuery(`
        SELECT RTRIM(sc6.C6_NUM) pedido,
               MAX(RTRIM(sa1.A1_NOME)) cliente, MAX(RTRIM(sc5.C5_ZTIPO)) buCod,
               MAX(RTRIM(sa3.A3_NOME)) vendedor, MIN(RTRIM(sc6.C6_ENTREG)) entrega,
               CAST(SUM(sc6.C6_PRCVEN * (1 + ISNULL(b1.B1_IPI,0)/100) * (sc6.C6_QTDVEN - sc6.C6_QTDENT)) AS NUMERIC(14,2)) valorSaldo,
               COUNT(*) itensTotal,
               SUM(CASE WHEN (ISNULL(sb2.B2_QATU,0)-ISNULL(sb2.B2_QEMP,0)-ISNULL(sb2.B2_QEMPSA,0)-ISNULL(sb2.B2_QTNP,0)-ISNULL(sb2.B2_QACLASS,0)-ISNULL(sb2.B2_QEMPPRE,0))
                          >= (sc6.C6_QTDVEN - sc6.C6_QTDENT) THEN 1 ELSE 0 END) itensComEstoque
          FROM SC6010 sc6 WITH (NOLOCK)
          JOIN SC5010 sc5 WITH (NOLOCK) ON sc5.C5_FILIAL=sc6.C6_FILIAL AND sc5.C5_NUM=sc6.C6_NUM AND sc5.D_E_L_E_T_<>'*'
          LEFT JOIN SB1010 b1 WITH (NOLOCK) ON b1.B1_COD=sc6.C6_PRODUTO AND b1.D_E_L_E_T_<>'*'
          LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD=sc5.C5_CLIENTE AND sa1.A1_LOJA=sc5.C5_LOJACLI AND sa1.D_E_L_E_T_<>'*'
          LEFT JOIN SA3010 sa3 WITH (NOLOCK) ON sa3.A3_COD=sc5.C5_VEND1 AND sa3.D_E_L_E_T_<>'*'
          LEFT JOIN SB2010 sb2 WITH (NOLOCK) ON sb2.B2_FILIAL='01' AND sb2.B2_COD=sc6.C6_PRODUTO AND sb2.B2_LOCAL=sc6.C6_LOCAL AND sb2.D_E_L_E_T_<>'*'
         WHERE sc6.C6_FILIAL='01' AND sc6.D_E_L_E_T_<>'*' AND sc6.C6_BLQ=' '
           AND (sc6.C6_QTDVEN - sc6.C6_QTDENT) > 0
           AND RTRIM(sc6.C6_CF) IN (${inLista(cfops)})
           AND RTRIM(sc6.C6_ENTREG) <> '' AND RTRIM(sc6.C6_ENTREG) <= @fimMes
           ${notIn}
         GROUP BY sc6.C6_NUM
         ORDER BY MIN(RTRIM(sc6.C6_ENTREG)) ASC`, { fimMes });

      const pedidos = rows.map(r => {
        const itensTotal = N(r.itensTotal), comEstoque = N(r.itensComEstoque);
        const classificacao = comEstoque >= itensTotal ? 'FATURAVEL' : (comEstoque === 0 ? 'TRAVADO' : 'PARCIAL');
        const ent = trim(r.entrega);
        return {
          pedido: trim(r.pedido), cliente: trim(r.cliente) || '—', buCod: trim(r.buCod),
          vendedor: trim(r.vendedor), entrega: ent,
          entregaBR: ent.length === 8 ? `${ent.slice(6, 8)}/${ent.slice(4, 6)}/${ent.slice(0, 4)}` : '',
          atrasada: ent < ymd(hoje),
          valorSaldo: N(r.valorSaldo), itensTotal, itensComEstoque: comEstoque, classificacao
        };
      });

      return res.json({
        mes, qtd: pedidos.length, valorTotal: r2(pedidos.reduce((a, p) => a + p.valorSaldo, 0)),
        comEstoque: pedidos.filter(p => p.classificacao === 'FATURAVEL').length,
        pedidos, geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro controle/faturaveis:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

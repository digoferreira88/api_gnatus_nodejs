// GET /planejamento/faturabilidade?bu=&vendedor=&inicio=YYYYMMDD&fim=YYYYMMDD
//
// Dashboard de FATURABILIDADE (pedida da diretoria): cruza carteira de pedidos
// (SC6) x estoque (SB2) e responde "quanto da carteira aberta dá pra faturar JÁ,
// com base no estoque", alocando o estoque físico entre os pedidos por prioridade
// de DATA DE ENTREGA (mais antiga primeiro), pra dois pedidos não disputarem a
// mesma unidade. Inclui faturados + NF do período.
//
// Estoque alocável = B2_QATU - empenhos de produção/terceiros (NÃO desconta a
// B2_RESERVA, que são os próprios pedidos de venda que estamos alocando).
//
// Permissão 3002 (Planejamento - Faturabilidade).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([3002]);
const { getCfops, inLista } = require('../vendas/_cfops');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

const STATUS_LABEL = {
  10: 'Novo / sem liberação', 20: 'Aguardando Financeiro', 25: 'Financeiro Bloqueado',
  30: 'Aguardando Planejamento', 40: 'Formulação Financeira', 50: 'Liberação de Estoque',
  60: 'Aguardando Faturamento', 99: 'Faturado'
};

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const ymdParaBR = (s) => { s = trim(s); return s.length === 8 ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : ''; };

module.exports = (app) => ({
  verb: 'get',
  route: '/faturabilidade',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const bu = trim(req.query.bu);
    const vendedor = trim(req.query.vendedor);
    // Período dos faturados (default: mês atual até hoje)
    const hoje = new Date();
    const inicio = /^\d{8}$/.test(trim(req.query.inicio)) ? trim(req.query.inicio) : ymd(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    const fim = /^\d{8}$/.test(trim(req.query.fim)) ? trim(req.query.fim) : ymd(hoje);

    try {
      const cfopsCarteira = await getCfops(Pg, 'carteira');
      const cfopsFat = await getCfops(Pg, 'faturamento');
      if (!cfopsCarteira.length) return res.status(500).json({ message: 'Lista de CFOPs de carteira vazia (tab_vendas_cfop).' });

      const filtros = [];
      const params = { inicio, fim };
      if (bu) { filtros.push(`AND RTRIM(sc5.C5_ZTIPO) = @bu`); params.bu = bu; }
      if (vendedor) { filtros.push(`AND @vend IN (RTRIM(sc5.C5_VEND1), RTRIM(sc5.C5_VEND2), RTRIM(sc5.C5_VEND3))`); params.vend = vendedor; }

      // ---------- 1) Itens da carteira ABERTA (saldo a faturar > 0) ----------
      const itens = await Protheus.connectAndQuery(`
        SELECT RTRIM(sc6.C6_NUM) pedido, RTRIM(sc6.C6_ITEM) item,
               RTRIM(sc6.C6_PRODUTO) produto, RTRIM(sc6.C6_LOCAL) local,
               RTRIM(b1.B1_DESC) descricao,
               (sc6.C6_QTDVEN - sc6.C6_QTDENT) saldo,
               sc6.C6_PRCVEN prcven, ISNULL(b1.B1_IPI, 0) ipi,
               RTRIM(sc6.C6_ENTREG) entrega,
               RTRIM(sc5.C5_CLIENTE) cliCod, RTRIM(sc5.C5_LOJACLI) cliLoja, RTRIM(sa1.A1_NOME) cliente,
               RTRIM(sc5.C5_VEND1) vendCod, RTRIM(sa3.A3_NOME) vendedor,
               RTRIM(sc5.C5_ZTIPO) buCod,
               pe.estatus_cod estatusCod
          FROM SC6010 sc6 WITH (NOLOCK)
          JOIN SC5010 sc5 WITH (NOLOCK)
            ON sc5.C5_FILIAL = sc6.C6_FILIAL AND sc5.C5_NUM = sc6.C6_NUM AND sc5.D_E_L_E_T_ <> '*'
          LEFT JOIN SB1010 b1 WITH (NOLOCK) ON b1.B1_COD = sc6.C6_PRODUTO AND b1.D_E_L_E_T_ <> '*'
          LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = sc5.C5_CLIENTE AND sa1.A1_LOJA = sc5.C5_LOJACLI AND sa1.D_E_L_E_T_ <> '*'
          LEFT JOIN SA3010 sa3 WITH (NOLOCK) ON sa3.A3_COD = sc5.C5_VEND1 AND sa3.D_E_L_E_T_ <> '*'
          LEFT JOIN pedidos_estatus pe ON pe.c6_filial = sc6.C6_FILIAL AND pe.c6_num = sc6.C6_NUM AND pe.c6_item = sc6.C6_ITEM
         WHERE sc6.D_E_L_E_T_ <> '*' AND sc6.C6_FILIAL = '01'
           AND sc6.C6_BLQ = ' ' AND (sc6.C6_QTDVEN - sc6.C6_QTDENT) > 0
           AND RTRIM(sc6.C6_CF) IN (${inLista(cfopsCarteira)})
           ${filtros.join(' ')}`, params);

      // ---------- 2) Estoque (SB2) — alocável por produto/local ----------
      const sb2 = await Protheus.connectAndQuery(`
        SELECT RTRIM(B2_COD) produto, RTRIM(B2_LOCAL) local,
               (B2_QATU - B2_QEMP - B2_QEMPSA - B2_QTNP - B2_QACLASS - B2_QEMPPRE) alocavel
          FROM SB2010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*' AND B2_FILIAL = '01'`, {});
      const pool = new Map();   // produto|local -> qtd alocável
      sb2.forEach(s => pool.set(`${trim(s.produto)}|${trim(s.local)}`, Math.max(0, N(s.alocavel))));

      // ---------- 3) BU labels (SX5 Z1) ----------
      const buMap = new Map();
      try {
        const sx5 = await Protheus.connectAndQuery(
          `SELECT RTRIM(X5_CHAVE) chave, RTRIM(X5_DESCRI) descri FROM SX5010 WITH (NOLOCK)
            WHERE X5_TABELA = 'Z1' AND D_E_L_E_T_ <> '*'`, {});
        sx5.forEach(x => buMap.set(trim(x.chave), trim(x.descri)));
      } catch (e) { /* usa o código como label */ }
      const buLabel = (cod) => buMap.get(cod) || cod || '(sem BU)';

      // ---------- 4) Normaliza itens + ALOCA por prioridade (entrega mais antiga) ----------
      const linhas = itens.map(it => {
        const saldo = N(it.saldo);
        const prcUnit = r2(N(it.prcven) * (1 + N(it.ipi) / 100));
        return {
          pedido: trim(it.pedido), item: trim(it.item), produto: trim(it.produto),
          local: trim(it.local), descricao: trim(it.descricao),
          saldo, prcUnit, valorSaldo: r2(saldo * prcUnit),
          entrega: trim(it.entrega) || '99999999',
          cliCod: trim(it.cliCod), cliLoja: trim(it.cliLoja), cliente: trim(it.cliente),
          vendCod: trim(it.vendCod), vendedor: trim(it.vendedor),
          buCod: trim(it.buCod), estatusCod: N(it.estatusCod),
          qtdFaturavel: 0, valorFaturavel: 0
        };
      });
      // prioridade global: entrega ASC (atrasados/mais antigos consomem 1º)
      linhas.sort((a, b) => a.entrega.localeCompare(b.entrega));
      linhas.forEach(l => {
        const k = `${l.produto}|${l.local}`;
        const disp = pool.get(k) || 0;
        const fat = Math.min(l.saldo, disp);
        if (fat > 0) { pool.set(k, disp - fat); l.qtdFaturavel = fat; l.valorFaturavel = r2(fat * l.prcUnit); }
      });

      // ---------- 5) Agrega por PEDIDO ----------
      const ped = new Map();
      linhas.forEach(l => {
        if (!ped.has(l.pedido)) ped.set(l.pedido, {
          pedido: l.pedido, cliente: l.cliente, cliCod: l.cliCod, cliLoja: l.cliLoja,
          vendedor: l.vendedor, vendCod: l.vendCod, buCod: l.buCod, bu: buLabel(l.buCod),
          estatusCod: l.estatusCod, estatus: STATUS_LABEL[l.estatusCod] || `Status ${l.estatusCod}`,
          entrega: l.entrega, itens: 0, valorTotal: 0, valorFaturavel: 0, valorTravado: 0,
          gargalo: null
        });
        const p = ped.get(l.pedido);
        p.itens += 1;
        p.valorTotal = r2(p.valorTotal + l.valorSaldo);
        p.valorFaturavel = r2(p.valorFaturavel + l.valorFaturavel);
        const travadoItem = r2(l.valorSaldo - l.valorFaturavel);
        p.valorTravado = r2(p.valorTravado + travadoItem);
        if (l.entrega < p.entrega) p.entrega = l.entrega;
        if (travadoItem > 0 && (!p.gargalo || travadoItem > p.gargalo.valorTravado)) {
          p.gargalo = { produto: l.produto, descricao: l.descricao, faltam: r2(l.saldo - l.qtdFaturavel), valorTravado: travadoItem };
        }
      });
      const pedidos = Array.from(ped.values()).map(p => {
        p.percentual = p.valorTotal > 0 ? r2((p.valorFaturavel / p.valorTotal) * 100) : 0;
        p.classificacao = p.valorTravado < 0.01 ? 'FATURAVEL' : (p.valorFaturavel < 0.01 ? 'TRAVADO' : 'PARCIAL');
        p.entregaBR = ymdParaBR(p.entrega);
        return p;
      }).sort((a, b) => b.valorTravado - a.valorTravado || b.valorTotal - a.valorTotal);

      // ---------- 6) KPIs ----------
      const somaSe = (f, campo) => r2(pedidos.filter(f).reduce((s, p) => s + p[campo], 0));
      const contaSe = (f) => pedidos.filter(f).length;
      const valorFaturavelTotal = r2(pedidos.reduce((s, p) => s + p.valorFaturavel, 0));
      const valorCarteira = r2(pedidos.reduce((s, p) => s + p.valorTotal, 0));
      const kpis = {
        carteira: { qtdPedidos: pedidos.length, valor: valorCarteira },
        faturavel: { qtdPedidos: contaSe(p => p.classificacao === 'FATURAVEL'), valor: somaSe(p => p.classificacao === 'FATURAVEL', 'valorTotal') },
        parcial: { qtdPedidos: contaSe(p => p.classificacao === 'PARCIAL'), valorFaturavel: somaSe(p => p.classificacao === 'PARCIAL', 'valorFaturavel') },
        travado: { qtdPedidos: contaSe(p => p.classificacao === 'TRAVADO'), valor: somaSe(p => p.classificacao === 'TRAVADO', 'valorTotal') },
        valorFaturavelTotal,
        valorTravadoTotal: r2(valorCarteira - valorFaturavelTotal),
        percentualFaturavel: valorCarteira > 0 ? r2((valorFaturavelTotal / valorCarteira) * 100) : 0
      };

      // ---------- 7) Por BU ----------
      const buAgg = new Map();
      pedidos.forEach(p => {
        if (!buAgg.has(p.buCod)) buAgg.set(p.buCod, { bu: p.bu, qtdPedidos: 0, valorTotal: 0, valorFaturavel: 0, valorTravado: 0 });
        const b = buAgg.get(p.buCod);
        b.qtdPedidos++; b.valorTotal = r2(b.valorTotal + p.valorTotal);
        b.valorFaturavel = r2(b.valorFaturavel + p.valorFaturavel); b.valorTravado = r2(b.valorTravado + p.valorTravado);
      });
      const porBU = Array.from(buAgg.values()).sort((a, b) => b.valorTotal - a.valorTotal);

      // ---------- 8) Por status (carteira aberta) ----------
      const stAgg = new Map();
      pedidos.forEach(p => {
        if (!stAgg.has(p.estatusCod)) stAgg.set(p.estatusCod, { estatusCod: p.estatusCod, estatus: p.estatus, qtdPedidos: 0, valor: 0 });
        const s = stAgg.get(p.estatusCod);
        s.qtdPedidos++; s.valor = r2(s.valor + p.valorTotal);
      });
      const porStatus = Array.from(stAgg.values()).sort((a, b) => a.estatusCod - b.estatusCod);

      // ---------- 9) Produtos gargalo (travam mais valor) ----------
      const gAgg = new Map();
      linhas.forEach(l => {
        const falta = l.saldo - l.qtdFaturavel;
        if (falta <= 0) return;
        if (!gAgg.has(l.produto)) gAgg.set(l.produto, { produto: l.produto, descricao: l.descricao, demanda: 0, falta: 0, valorTravado: 0, pedidos: new Set() });
        const g = gAgg.get(l.produto);
        g.demanda = r2(g.demanda + l.saldo); g.falta = r2(g.falta + falta);
        g.valorTravado = r2(g.valorTravado + (falta * l.prcUnit)); g.pedidos.add(l.pedido);
      });
      const gargalos = Array.from(gAgg.values())
        .map(g => ({ produto: g.produto, descricao: g.descricao, demanda: g.demanda, falta: g.falta, valorTravado: g.valorTravado, pedidosAfetados: g.pedidos.size }))
        .sort((a, b) => b.valorTravado - a.valorTravado).slice(0, 20);

      // ---------- 10) Faturados + NF no período (por emissão da NF) ----------
      let faturados = { periodo: { inicio, fim }, pedidosComNF: 0, nfsEmitidas: 0, valorFaturado: 0 };
      if (cfopsFat.length) {
        const fr = await Protheus.connectAndQuery(`
          SELECT COUNT(DISTINCT RTRIM(sd2.D2_PEDIDO)) pedidosComNF,
                 COUNT(DISTINCT RTRIM(sd2.D2_DOC) + '|' + RTRIM(sd2.D2_SERIE)) nfsEmitidas,
                 SUM(sd2.D2_VALBRUT - ISNULL(sd2.D2_VALDEV, 0)) valorFaturado
            FROM SD2010 sd2 WITH (NOLOCK)
           WHERE sd2.D_E_L_E_T_ <> '*' AND sd2.D2_FILIAL = '01'
             AND sd2.D2_EMISSAO BETWEEN @inicio AND @fim
             AND RTRIM(sd2.D2_CF) IN (${inLista(cfopsFat)})
             AND RTRIM(sd2.D2_PEDIDO) <> ''`, { inicio, fim });
        if (fr[0]) faturados = {
          periodo: { inicio, fim },
          pedidosComNF: N(fr[0].pedidosComNF), nfsEmitidas: N(fr[0].nfsEmitidas), valorFaturado: r2(fr[0].valorFaturado)
        };
      }

      return res.json({
        geradoEm: new Date().toISOString(),
        filtros: { bu: bu || null, vendedor: vendedor || null, periodoFaturados: { inicio, fim } },
        kpis, porBU, porStatus, gargalos, faturados,
        pedidos
      });
    } catch (err) {
      console.error('Erro planejamento/faturabilidade:', err);
      return res.status(500).json({ message: 'Erro ao gerar faturabilidade: ' + err.message });
    }
  }
});

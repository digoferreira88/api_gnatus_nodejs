// GET /planejamento/controle?mes=YYYYMM&responsavel=ID&bu=
//
// Gestão à vista do Planejamento. Substitui a planilha "Controle de Pedidos":
//   - Quadro (kanban) dos pedidos em controle, agrupado por status (PG).
//   - Dados vivos do Protheus por pedido (cliente, valor, estatus, NF).
//   - AUTO-FATURADO: pedido faturado no ERP (estatus 99) -> move sozinho p/
//     "TOTALMENTE FATURADO".
//   - Painel de meta diária (meta mensal config x faturado real do Protheus).
//   - Resumo por responsável.
//
// Permissão 3003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([3003]);
const { getCfops, inLista } = require('../vendas/_cfops');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = (s) => { s = trim(s); return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)); };
const inStr = (arr) => arr.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',');

// dias úteis (seg-sex) entre duas datas YYYYMMDD, inclusivo
function diasUteis(deYmd, ateYmd) {
  let d = parseYmd(deYmd); const end = parseYmd(ateYmd); let n = 0;
  while (d <= end) { const w = d.getDay(); if (w >= 1 && w <= 5) n++; d = new Date(d.getTime() + 864e5); }
  return n;
}

module.exports = (app) => ({
  verb: 'get',
  route: '/controle',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const hoje = new Date();
    const mes = /^\d{6}$/.test(trim(req.query.mes)) ? trim(req.query.mes) : `${hoje.getFullYear()}${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const ano = +mes.slice(0, 4), mm = +mes.slice(4, 6);
    const inicioMes = `${mes}01`;
    const fimMes = ymd(new Date(ano, mm, 0));   // último dia do mês
    const respFiltro = trim(req.query.responsavel);
    const buFiltro = trim(req.query.bu);

    try {
      // ---------- Status + meta ----------
      const statusRows = await Pg.connectAndQuery(
        `SELECT nome, ordem, cor, e_faturado FROM tab_plan_status WHERE ativo = true ORDER BY ordem, nome`, {});
      const statusFaturado = (statusRows.find(s => s.e_faturado)?.nome) || 'TOTALMENTE FATURADO';

      const metaRow = (await Pg.connectAndQuery(`SELECT meta_mensal, dias_uteis FROM tab_plan_meta WHERE mes = @mes`, { mes }))[0]
        || { meta_mensal: 0, dias_uteis: 21 };

      // ---------- Controle (PG) ----------
      const conds = [];
      const pgParams = {};
      if (respFiltro) { conds.push(`AND responsavel_id = @resp`); pgParams.resp = N(respFiltro); }
      if (buFiltro) { conds.push(`AND tipo_bu = @bu`); pgParams.bu = buFiltro; }
      const controle = await Pg.connectAndQuery(
        `SELECT id, pedido, responsavel_id, responsavel_nome, status, tipo_bu, categoria, nf, obs,
                valor_snapshot, dt_inicio, ultima_movimentacao, faturado_auto
           FROM tab_plan_controle WHERE filial = '01' ${conds.join(' ')}`, pgParams);

      // ---------- Dados vivos do Protheus p/ os pedidos em controle ----------
      const liveMap = new Map();
      if (controle.length) {
        const inP = inStr(controle.map(c => c.pedido));
        const live = await Protheus.connectAndQuery(`
          SELECT RTRIM(sc5.C5_NUM) pedido, RTRIM(sa1.A1_NOME) cliente, RTRIM(sc5.C5_ZTIPO) buCod,
                 CAST(ISNULL(tp6.total,0) AS NUMERIC(14,2)) valorAtual,
                 pe.maxEstatus estatusCod, pe.dataLib dataLib, RTRIM(nf.doc) nfDoc
            FROM SC5010 sc5 WITH (NOLOCK)
            LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = sc5.C5_CLIENTE AND sa1.A1_LOJA = sc5.C5_LOJACLI AND sa1.D_E_L_E_T_ <> '*'
            LEFT JOIN total_pedido_sc6 tp6 WITH (NOLOCK) ON tp6.c6_num = sc5.C5_NUM
            LEFT JOIN (SELECT c6_filial, c6_num, MAX(estatus_cod) maxEstatus, MAX(RTRIM(c9_datalib)) dataLib
                         FROM pedidos_estatus WHERE c6_num IN (${inP}) GROUP BY c6_filial, c6_num) pe
              ON pe.c6_filial = sc5.C5_FILIAL AND pe.c6_num = sc5.C5_NUM
            LEFT JOIN (SELECT D2_FILIAL, D2_PEDIDO, MAX(RTRIM(D2_DOC)) doc FROM SD2010 WITH (NOLOCK)
                        WHERE D_E_L_E_T_ <> '*' AND RTRIM(D2_DOC) <> '' AND RTRIM(D2_PEDIDO) IN (${inP})
                        GROUP BY D2_FILIAL, D2_PEDIDO) nf
              ON nf.D2_FILIAL = sc5.C5_FILIAL AND nf.D2_PEDIDO = sc5.C5_NUM
           WHERE sc5.C5_FILIAL = '01' AND sc5.D_E_L_E_T_ <> '*' AND RTRIM(sc5.C5_NUM) IN (${inP})`, {});
        live.forEach(l => liveMap.set(trim(l.pedido), {
          cliente: trim(l.cliente), buCod: trim(l.buCod), valorAtual: N(l.valorAtual),
          estatusCod: N(l.estatusCod), dataLib: trim(l.dataLib), nfDoc: trim(l.nfDoc)
        }));
      }

      // ---------- AUTO-FATURADO: estatus 99 no Protheus -> move p/ Faturado ----------
      const autoFaturar = [];
      controle.forEach(c => {
        const live = liveMap.get(c.pedido);
        if (live && live.estatusCod === 99 && trim(c.status) !== statusFaturado) autoFaturar.push({ c, nf: live.nfDoc });
      });
      for (const { c, nf } of autoFaturar) {
        try {
          await Pg.connectAndQuery(
            `UPDATE tab_plan_controle SET status=@st, nf=COALESCE(NULLIF(@nf,''), nf), faturado_auto=true,
                    ultima_movimentacao=NOW(), atualizado_em=NOW() WHERE filial='01' AND pedido=@ped`,
            { st: statusFaturado, nf: nf || '', ped: c.pedido });
          await Pg.connectAndQuery(
            `INSERT INTO tab_plan_controle_hist (pedido, de_status, para_status, obs, usuario_nome)
             VALUES (@ped, @de, @para, 'Faturado automaticamente (NF emitida no Protheus)', 'sistema')`,
            { ped: c.pedido, de: trim(c.status), para: statusFaturado });
          c.status = statusFaturado; c.faturado_auto = true; if (nf) c.nf = nf;
        } catch (e) { console.warn('controle auto-faturar:', e.message); }
      }

      // ---------- Monta cards ----------
      const corStatus = new Map(statusRows.map(s => [s.nome, s.cor]));
      const cards = controle.map(c => {
        const live = liveMap.get(c.pedido) || {};
        return {
          pedido: c.pedido,
          responsavelId: c.responsavel_id, responsavelNome: trim(c.responsavel_nome) || '(sem responsável)',
          status: trim(c.status), statusCor: corStatus.get(trim(c.status)) || '#6b7a90',
          tipoBu: trim(c.tipo_bu) || trim(live.buCod), categoria: trim(c.categoria),
          nf: trim(c.nf) || trim(live.nfDoc), obs: c.obs || '',
          valor: r2(c.valor_snapshot != null ? N(c.valor_snapshot) : N(live.valorAtual)),
          cliente: trim(live.cliente) || '—',
          estatusProtheus: live.estatusCod || 0,
          faturadoProtheus: live.estatusCod === 99,
          faturadoAuto: !!c.faturado_auto,
          dtInicio: c.dt_inicio, ultimaMov: c.ultima_movimentacao
        };
      });
      if (buFiltro) { /* já filtrado no PG por tipo_bu; mantém */ }

      // ---------- Quadro por status ----------
      const board = statusRows.map(s => ({
        status: s.nome, cor: s.cor, eFaturado: s.e_faturado,
        cards: cards.filter(c => c.status === s.nome),
        qtd: 0, valor: 0
      }));
      board.forEach(col => { col.qtd = col.cards.length; col.valor = r2(col.cards.reduce((a, c) => a + c.valor, 0)); });

      // ---------- Faturamento real do Protheus (mês + hoje) ----------
      let faturadoMes = 0, faturadoHoje = 0;
      try {
        const cfopsFat = await getCfops(Pg, 'faturamento');
        if (cfopsFat.length) {
          const fr = await Protheus.connectAndQuery(`
            SELECT SUM(CASE WHEN sd2.D2_EMISSAO BETWEEN @ini AND @fim THEN sd2.D2_VALBRUT - ISNULL(sd2.D2_VALDEV,0) ELSE 0 END) mes,
                   SUM(CASE WHEN sd2.D2_EMISSAO = @hoje THEN sd2.D2_VALBRUT - ISNULL(sd2.D2_VALDEV,0) ELSE 0 END) hoje
              FROM SD2010 sd2 WITH (NOLOCK)
             WHERE sd2.D_E_L_E_T_ <> '*' AND sd2.D2_FILIAL = '01'
               AND sd2.D2_EMISSAO BETWEEN @ini AND @fim AND RTRIM(sd2.D2_CF) IN (${inLista(cfopsFat)})`,
            { ini: inicioMes, fim: fimMes, hoje: ymd(hoje) });
          faturadoMes = r2(fr[0]?.mes); faturadoHoje = r2(fr[0]?.hoje);
        }
      } catch (e) { console.warn('controle faturado:', e.message); }

      // ---------- Meta ----------
      const metaMensal = N(metaRow.meta_mensal);
      const diasUteisTot = N(metaRow.dias_uteis) || 21;
      const hojeYmd = ymd(hoje);
      const dentroDoMes = hojeYmd >= inicioMes && hojeYmd <= fimMes;
      const diasRestantes = dentroDoMes ? Math.max(1, diasUteis(hojeYmd, fimMes)) : (hojeYmd < inicioMes ? diasUteisTot : 1);
      const faltaReal = r2(metaMensal - faturadoMes);
      const meta = {
        mes, metaMensal, diasUteis: diasUteisTot,
        metaDiaria: r2(metaMensal / diasUteisTot),
        faturadoMes, faturadoHoje, faltaReal,
        diasRestantes,
        novaMetaDiaria: r2(Math.max(0, faltaReal) / diasRestantes),
        pctAtingido: metaMensal > 0 ? r2((faturadoMes / metaMensal) * 100) : 0,
        metaDiariaAtingidaHoje: faturadoHoje >= r2(metaMensal / diasUteisTot)
      };

      // ---------- Por responsável ----------
      const respAgg = new Map();
      cards.forEach(c => {
        const key = c.responsavelId || 0;
        if (!respAgg.has(key)) respAgg.set(key, { responsavelId: c.responsavelId, responsavelNome: c.responsavelNome, qtd: 0, valorMonitorado: 0, qtdFaturado: 0, valorFaturado: 0 });
        const a = respAgg.get(key);
        a.qtd++;
        if (c.status === statusFaturado) { a.qtdFaturado++; a.valorFaturado = r2(a.valorFaturado + c.valor); }
        else a.valorMonitorado = r2(a.valorMonitorado + c.valor);
      });
      const porResponsavel = [...respAgg.values()].sort((a, b) => b.valorFaturado - a.valorFaturado || b.qtd - a.qtd);

      return res.json({
        mes, periodo: { inicio: inicioMes, fim: fimMes },
        status: statusRows.map(s => ({ nome: s.nome, cor: s.cor, ordem: s.ordem, eFaturado: s.e_faturado })),
        meta, board, porResponsavel,
        kpis: {
          totalControle: cards.length,
          valorControle: r2(cards.reduce((a, c) => a + c.valor, 0)),
          qtdFaturados: cards.filter(c => c.status === statusFaturado).length,
          autoFaturadosAgora: autoFaturar.length
        },
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro planejamento/controle:', err);
      return res.status(500).json({ message: 'Erro ao carregar controle: ' + err.message });
    }
  }
});

// DRE > Centro de Custo — visao gerencial baseada em PEDIDOS DE COMPRA (SC7),
// agregados por CC e por mes. Diferente das outras visoes do DRE (Gerencial/
// Contabil) que partem de SE2/SD2 (notas), esta parte de SC7 (compromisso de
// gasto) — util pra ver o gasto comprometido antes de virar nota.
//
// REGRA DE INCLUSAO: pedidos com C7_EMISSAO no periodo. Exclui apenas os
// REJEITADOS em alcada — SCR010.CR_STATUS = '06', cruzando tanto via PC
// (CR_TIPO='PC', CR_NUM = C7_NUM) quanto via SC origem (CR_TIPO='SC',
// CR_NUM = C7_NUMSC ou C7_ZNUMPRO). O fallback SC eh importante porque a
// alcada SCR no nivel PC foi desativada em 11/2025 — pedidos novos so tem
// alcada via SC origem (ver compras.pedidos.js:149).
//
// Inclui evolucao mensal e indicadores de orcamento quando ha valor cadastrado
// em tab_centro_custo_orcamento. Distribuicao linear (anual/12) pra YTD.
//
// Perm 10001 (mesma do DRE Gerencial).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10001]);

const trim = (v) => String(v || '').trim();
const toN = (v) => Number(v || 0);

// '202601' -> 'jan/26'
const MESES_PT = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const ymesLabel = (ymes) => {
  const s = String(ymes);
  if (s.length !== 6) return s;
  const m = parseInt(s.slice(4, 6), 10) - 1;
  const ano = s.slice(2, 4);
  return (MESES_PT[m] || '?') + '/' + ano;
};

// Status de execucao do orcamento (YTD)
const statusOrcamento = (pctYtd) => {
  if (pctYtd == null) return null;
  if (pctYtd >= 100) return 'ESTOURADO';
  if (pctYtd >= 85)  return 'ATENCAO';
  return 'OK';
};

module.exports = (app) => ({
  verb: 'get',
  route: '/dre/centro-custo',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const inicio = trim(req.query.inicio); // YYYYMMDD
    const fim    = trim(req.query.fim);

    if (!/^\d{8}$/.test(inicio) || !/^\d{8}$/.test(fim)) {
      return res.status(400).json({ message: 'inicio e fim sao obrigatorios (YYYYMMDD).' });
    }
    if (inicio > fim) {
      return res.status(400).json({ message: 'inicio nao pode ser maior que fim.' });
    }

    try {
      // 1) Pedidos de compra do periodo (detalhe por item)
      const sc7 = await Protheus.connectAndQuery(`
        SELECT
          RTRIM(sc7.C7_NUM)     AS numero,
          RTRIM(sc7.C7_NUMSC)   AS origemSC,
          RTRIM(sc7.C7_ZNUMPRO) AS origemProcesso,
          RTRIM(sc7.C7_CC)      AS cc,
          sc7.C7_EMISSAO        AS emissao,
          sc7.C7_TOTAL          AS valor
          FROM SC7010 sc7 WITH (NOLOCK)
         WHERE sc7.D_E_L_E_T_ <> '*'
           AND sc7.C7_FILIAL = '01'
           AND sc7.C7_EMISSAO BETWEEN @inicio AND @fim
           AND RTRIM(sc7.C7_CC) <> ''
      `, { inicio, fim });

      // 2) Numeros de pedido (PC) e SC de origem -> consulta SCR pra achar REJEITADOS
      const numerosPC = [...new Set(sc7.map(r => trim(r.numero)).filter(Boolean))];
      const numerosSC = [...new Set(sc7.map(r => trim(r.origemSC) || trim(r.origemProcesso)).filter(Boolean))];

      const rejeitadosPC = new Set();
      const rejeitadosSC = new Set();
      const BATCH = 500;

      const fetchRejeitados = async (numeros, tipo, sink) => {
        for (let i = 0; i < numeros.length; i += BATCH) {
          const slice = numeros.slice(i, i + BATCH);
          const inClause = slice.map((_, k) => `@n${k}`).join(',');
          const p = { tipo };
          slice.forEach((n, k) => { p[`n${k}`] = n; });
          try {
            const rows = await Protheus.connectAndQuery(`
              SELECT RTRIM(CR_NUM) numero
                FROM SCR010 WITH (NOLOCK)
               WHERE D_E_L_E_T_ <> '*'
                 AND CR_FILIAL = '01'
                 AND CR_TIPO = @tipo
                 AND CR_STATUS = '06'
                 AND CR_NUM IN (${inClause})
            `, p);
            rows.forEach(r => sink.add(trim(r.numero)));
          } catch (e) {
            console.warn(`dre-centro-custo: SCR ${tipo} batch err:`, e.message);
          }
        }
      };

      await Promise.all([
        fetchRejeitados(numerosPC, 'PC', rejeitadosPC),
        fetchRejeitados(numerosSC, 'SC', rejeitadosSC)
      ]);

      // 3) Filtra + agrega por CC e por ymes
      const porCC = new Map();   // cc -> { valor, qtdItens, pedidos:Set<numero>, porMes: Map<ymes,valor> }
      const porMes = new Map();  // ymes -> { valor, qtdItens }

      for (const r of sc7) {
        const num = trim(r.numero);
        const sc  = trim(r.origemSC) || trim(r.origemProcesso);
        // Exclui rejeitados (PC ou SC de origem)
        if (rejeitadosPC.has(num)) continue;
        if (sc && rejeitadosSC.has(sc)) continue;

        const cc = trim(r.cc);
        const ymes = String(r.emissao || '').slice(0, 6);
        const valor = toN(r.valor);

        if (!porCC.has(cc)) porCC.set(cc, { valor: 0, qtdItens: 0, pedidos: new Set(), porMes: new Map() });
        const agCc = porCC.get(cc);
        agCc.valor += valor;
        agCc.qtdItens += 1;
        agCc.pedidos.add(num);
        agCc.porMes.set(ymes, toN(agCc.porMes.get(ymes)) + valor);

        if (!porMes.has(ymes)) porMes.set(ymes, { valor: 0, qtdItens: 0 });
        const agMes = porMes.get(ymes);
        agMes.valor += valor;
        agMes.qtdItens += 1;
      }

      // 4) Descricoes dos CCs (CTT010)
      const ccs = [...porCC.keys()];
      const descricoes = new Map();
      if (ccs.length) {
        const inClause = ccs.map((_, i) => `@c${i}`).join(',');
        const p = {};
        ccs.forEach((c, i) => { p[`c${i}`] = c; });
        try {
          const rows = await Protheus.connectAndQuery(`
            SELECT RTRIM(CTT_CUSTO) cc, RTRIM(CTT_DESC01) descricao
              FROM CTT010 WITH (NOLOCK)
             WHERE D_E_L_E_T_ <> '*'
               AND CTT_FILIAL IN ('01', '  ', '')
               AND CTT_CUSTO IN (${inClause})
          `, p);
          rows.forEach(r => { if (!descricoes.has(trim(r.cc))) descricoes.set(trim(r.cc), trim(r.descricao)); });
        } catch (e) {
          console.warn('dre-centro-custo: CTT010 err:', e.message);
        }
      }

      // 5) Orcamento (anual) cadastrado em Postgres — usa o ANO do fim do periodo
      const anoFim = parseInt(fim.slice(0, 4), 10);
      const mesFim = parseInt(fim.slice(4, 6), 10);
      const hoje = new Date();
      const anoCorrente = hoje.getFullYear();

      const orcamentosRows = await Pg.connectAndQuery(`
        SELECT cc_codigo, cc_descricao, ano, valor_orcado
          FROM tab_centro_custo_orcamento
         WHERE ano = @ano`,
        { ano: anoFim });

      const orcamentoPorCC = new Map();
      orcamentosRows.forEach(o => {
        orcamentoPorCC.set(trim(o.cc_codigo), {
          ano: o.ano,
          valorOrcado: toN(o.valor_orcado),
          ccDescricao: trim(o.cc_descricao)
        });
      });

      // Fator YTD pra distribuicao linear:
      //  - ano fechado (anoFim < anoCorrente): usa 12/12 = 1.0
      //  - ano corrente: usa mesFim/12
      //  - ano futuro: 0
      const fatorYTD = anoFim < anoCorrente ? 1
                     : anoFim > anoCorrente ? 0
                     : Math.max(0, Math.min(12, mesFim)) / 12;

      // 6) Monta porCentroCusto ordenado por valor desc
      const valorTotal = [...porCC.values()].reduce((s, x) => s + x.valor, 0);
      const porCentroCusto = [...porCC.entries()].map(([cc, ag]) => {
        const orc = orcamentoPorCC.get(cc);
        let orcamento = null;
        if (orc) {
          const orcadoYTD = orc.valorOrcado * fatorYTD;
          const pctExecAnual = orc.valorOrcado > 0 ? (ag.valor / orc.valorOrcado) * 100 : null;
          const pctExecYTD   = orcadoYTD > 0 ? (ag.valor / orcadoYTD) * 100 : null;
          orcamento = {
            ano: orc.ano,
            valorOrcado: orc.valorOrcado,
            valorOrcadoYTD: orcadoYTD,
            saldoAnual: orc.valorOrcado - ag.valor,
            pctExecutadoAnual: pctExecAnual,
            pctExecutadoYTD: pctExecYTD,
            status: statusOrcamento(pctExecYTD)
          };
        }
        return {
          cc,
          descricao: descricoes.get(cc) || orc?.ccDescricao || '(sem descricao)',
          valor: ag.valor,
          qtdPedidos: ag.pedidos.size,
          qtdItens: ag.qtdItens,
          pctTotal: valorTotal > 0 ? (ag.valor / valorTotal) * 100 : 0,
          orcamento
        };
      }).sort((a, b) => b.valor - a.valor);

      // 7) Evolucao mensal — completa meses faltantes do range com 0
      const evolucao = [];
      const mesesNoRange = (() => {
        const out = [];
        let y = parseInt(inicio.slice(0, 4), 10);
        let m = parseInt(inicio.slice(4, 6), 10);
        const yEnd = anoFim;
        const mEnd = mesFim;
        while (y < yEnd || (y === yEnd && m <= mEnd)) {
          out.push(`${y}${String(m).padStart(2, '0')}`);
          m++; if (m > 12) { m = 1; y++; }
        }
        return out;
      })();
      mesesNoRange.forEach(ymes => {
        const ag = porMes.get(ymes) || { valor: 0, qtdItens: 0 };
        evolucao.push({ ymes, label: ymesLabel(ymes), valor: ag.valor, qtdItens: ag.qtdItens });
      });

      // 8) Totais agregados
      const qtdPedidosUnicos = new Set();
      sc7.forEach(r => {
        const num = trim(r.numero);
        const sc  = trim(r.origemSC) || trim(r.origemProcesso);
        if (rejeitadosPC.has(num)) return;
        if (sc && rejeitadosSC.has(sc)) return;
        qtdPedidosUnicos.add(num);
      });

      const orcadoAnualTotal = [...orcamentoPorCC.values()].reduce((s, o) => s + o.valorOrcado, 0);
      const orcadoYTDTotal   = orcadoAnualTotal * fatorYTD;

      return res.json({
        periodo: { inicio, fim, ano: anoFim, mesFim },
        geradoEm: new Date().toISOString(),
        totais: {
          valorTotal,
          qtdPedidos: qtdPedidosUnicos.size,
          qtdItens: [...porCC.values()].reduce((s, x) => s + x.qtdItens, 0),
          qtdCentros: porCC.size,
          qtdCentrosComOrcamento: orcamentoPorCC.size,
          valorOrcadoAnual: orcadoAnualTotal || null,
          valorOrcadoYTD: orcadoYTDTotal || null,
          pctExecutadoYTD: orcadoYTDTotal > 0 ? (valorTotal / orcadoYTDTotal) * 100 : null
        },
        porCentroCusto,
        evolucaoMensal: evolucao,
        // Diagnostico — util pro frontend mostrar "X pedidos rejeitados excluidos"
        excluidos: {
          rejeitadosPC: rejeitadosPC.size,
          rejeitadosSC: rejeitadosSC.size
        }
      });
    } catch (err) {
      console.error('dre-centro-custo:', err);
      return res.status(500).json({ message: 'Erro ao gerar DRE por centro de custo: ' + err.message });
    }
  }
});

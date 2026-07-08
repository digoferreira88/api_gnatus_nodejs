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
          RTRIM(sc7.C7_CONTA)   AS conta,
          RTRIM(sc7.C7_PRODUTO) AS produto,
          RTRIM(sc7.C7_DESCRI)  AS descProduto,
          RTRIM(sc7.C7_ITEM)    AS itemPed,
          RTRIM(sc7.C7_NOTA)    AS nota,
          RTRIM(sc7.C7_SERIE)   AS serie,
          RTRIM(sc7.C7_FORNECE) AS fornece,
          RTRIM(sc7.C7_LOJA)    AS forneceLoja,
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

      // 3) Filtra + agrega por CC e por ymes. Drill aninhado: dentro de cada CC,
      // quebra por conta contabil (C7_CONTA), e dentro de cada conta quebra por
      // item (C7_PRODUTO). Igual ao DRE Gerencial (expand de natureza → titulos).
      const porCC = new Map();   // cc -> { valor, qtdItens, pedidos:Set, porMes:Map, porConta:Map<conta, {valor, qtdItens, porItem:Map}> }
      const porMes = new Map();  // ymes -> { valor, qtdItens }

      for (const r of sc7) {
        const num = trim(r.numero);
        const sc  = trim(r.origemSC) || trim(r.origemProcesso);
        // Exclui rejeitados (PC ou SC de origem)
        if (rejeitadosPC.has(num)) continue;
        if (sc && rejeitadosSC.has(sc)) continue;

        const cc = trim(r.cc);
        const conta = trim(r.conta);
        const produto = trim(r.produto);
        const descProduto = trim(r.descProduto);
        const ymes = String(r.emissao || '').slice(0, 6);
        const valor = toN(r.valor);

        if (!porCC.has(cc)) porCC.set(cc, {
          valor: 0, qtdItens: 0, pedidos: new Set(),
          porMes: new Map(), porConta: new Map()
        });
        const agCc = porCC.get(cc);
        agCc.valor += valor;
        agCc.qtdItens += 1;
        agCc.pedidos.add(num);
        agCc.porMes.set(ymes, toN(agCc.porMes.get(ymes)) + valor);

        // Quebra por conta contabil dentro do CC
        const kConta = conta || '(sem conta)';
        if (!agCc.porConta.has(kConta)) agCc.porConta.set(kConta, {
          valor: 0, qtdItens: 0, porItem: new Map()
        });
        const aCt = agCc.porConta.get(kConta);
        aCt.valor += valor;
        aCt.qtdItens += 1;

        // Quebra por item DENTRO da conta contabil (drill aninhado)
        const kItem = produto || '(sem produto)';
        if (!aCt.porItem.has(kItem)) aCt.porItem.set(kItem, { descricao: descProduto, valor: 0, qtdItens: 0, docs: [] });
        const aIt = aCt.porItem.get(kItem);
        aIt.valor += valor;
        aIt.qtdItens += 1;
        // Mantém a primeira descrição não-vazia (caso o mesmo produto venha com descrições diferentes)
        if (!aIt.descricao && descProduto) aIt.descricao = descProduto;

        // Nível 4 (folha): documento/linha do pedido. NF (C7_NOTA) preenchida =
        // pedido já faturado (nota de entrada); vazia = compromisso ainda sem NF.
        aIt.docs.push({
          pedido: num,
          itemPed: trim(r.itemPed),
          nota: trim(r.nota),
          serie: trim(r.serie),
          emissao: String(r.emissao || ''),
          fornece: trim(r.fornece),
          forneceLoja: trim(r.forneceLoja),
          valor
        });

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

      // 4b) Descricoes das contas contabeis (CT1010) — todas as contas usadas
      // em qualquer CC. Uniao com Set pra evitar repeticao.
      const contasUnicas = new Set();
      for (const ag of porCC.values()) {
        for (const k of ag.porConta.keys()) {
          if (k && k !== '(sem conta)') contasUnicas.add(k);
        }
      }
      const descContas = new Map();
      if (contasUnicas.size) {
        const arr = [...contasUnicas];
        const inClause = arr.map((_, i) => `@k${i}`).join(',');
        const p = {};
        arr.forEach((c, i) => { p[`k${i}`] = c; });
        try {
          const rows = await Protheus.connectAndQuery(`
            SELECT RTRIM(CT1_CONTA) conta, RTRIM(CT1_DESC01) descricao
              FROM CT1010 WITH (NOLOCK)
             WHERE D_E_L_E_T_ <> '*'
               AND RTRIM(CT1_CONTA) IN (${inClause})
          `, p);
          rows.forEach(r => { if (!descContas.has(trim(r.conta))) descContas.set(trim(r.conta), trim(r.descricao)); });
        } catch (e) {
          console.warn('dre-centro-custo: CT1010 err:', e.message);
        }
      }

      // 4c) Nomes dos fornecedores (SA2010) pros documentos (nivel 4 do drill).
      const fornecedoresUnicos = new Set();
      for (const ag of porCC.values())
        for (const ct of ag.porConta.values())
          for (const it of ct.porItem.values())
            for (const d of it.docs)
              if (d.fornece) fornecedoresUnicos.add(`${d.fornece}|${d.forneceLoja}`);
      const nomeFornecedor = new Map();
      if (fornecedoresUnicos.size) {
        const pares = [...fornecedoresUnicos];
        for (let i = 0; i < pares.length; i += 400) {
          const slice = pares.slice(i, i + 400);
          const ors = slice.map((_, k) => `(sa2.A2_COD = @f${k} AND sa2.A2_LOJA = @fl${k})`).join(' OR ');
          const p = {};
          slice.forEach((par, k) => { const [c, l] = par.split('|'); p[`f${k}`] = c; p[`fl${k}`] = l; });
          try {
            const rows = await Protheus.connectAndQuery(`
              SELECT RTRIM(sa2.A2_COD) cod, RTRIM(sa2.A2_LOJA) loja,
                     RTRIM(sa2.A2_NREDUZ) nred, RTRIM(sa2.A2_NOME) nome
                FROM SA2010 sa2 WITH (NOLOCK)
               WHERE sa2.D_E_L_E_T_ <> '*' AND (${ors})`, p);
            rows.forEach(r => nomeFornecedor.set(`${trim(r.cod)}|${trim(r.loja)}`, trim(r.nred) || trim(r.nome)));
          } catch (e) {
            console.warn('dre-centro-custo: SA2010 err:', e.message);
          }
        }
      }

      // 5) Orcamento (anual) cadastrado em Postgres — usa o ANO do fim do periodo
      const anoFim = parseInt(fim.slice(0, 4), 10);
      const mesFim = parseInt(fim.slice(4, 6), 10);
      const hoje = new Date();
      const anoCorrente = hoje.getFullYear();

      // Tolera tabela inexistente (migration 51 ainda nao rodada em alguns ambientes)
      // — sem orcamento, o endpoint segue funcionando e nao mostra os indicadores.
      let orcamentosRows = [];
      try {
        orcamentosRows = await Pg.connectAndQuery(`
          SELECT cc_codigo, cc_descricao, ano, valor_orcado
            FROM tab_centro_custo_orcamento
           WHERE ano = @ano`,
          { ano: anoFim });
      } catch (e) {
        console.warn('dre-centro-custo: tab_centro_custo_orcamento indisponivel (rodar migration 51?):', e.message);
      }

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
        // Drill aninhado: dentro do CC, lista de contas contabeis; dentro de
        // cada conta, lista de itens. Tudo ordenado por valor desc.
        const porContaContabil = [...ag.porConta.entries()]
          .map(([conta, x]) => ({
            conta,
            descricao: descContas.get(conta) || '(sem descricao)',
            valor: x.valor,
            qtdItens: x.qtdItens,
            pctCC: ag.valor > 0 ? (x.valor / ag.valor) * 100 : 0,
            itens: [...x.porItem.entries()]
              .map(([produto, y]) => ({
                produto,
                descricao: y.descricao || '(sem descricao)',
                valor: y.valor,
                qtdItens: y.qtdItens,
                pctConta: x.valor > 0 ? (y.valor / x.valor) * 100 : 0,
                // Nivel 4: documentos (linhas de pedido) que compoem o item
                documentos: y.docs
                  .map(d => ({
                    pedido: d.pedido,
                    itemPed: d.itemPed,
                    nota: d.nota,
                    serie: d.serie,
                    emissao: d.emissao,
                    fornecedor: d.fornece,
                    fornecedorNome: nomeFornecedor.get(`${d.fornece}|${d.forneceLoja}`) || '',
                    valor: d.valor,
                    pctItem: y.valor > 0 ? (d.valor / y.valor) * 100 : 0
                  }))
                  .sort((a, b) => b.valor - a.valor)
              }))
              .sort((a, b) => b.valor - a.valor)
          }))
          .sort((a, b) => b.valor - a.valor);

        return {
          cc,
          descricao: descricoes.get(cc) || orc?.ccDescricao || '(sem descricao)',
          valor: ag.valor,
          qtdPedidos: ag.pedidos.size,
          qtdItens: ag.qtdItens,
          pctTotal: valorTotal > 0 ? (ag.valor / valorTotal) * 100 : 0,
          orcamento,
          porContaContabil
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

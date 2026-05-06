// Custo de produto: explode estrutura SG1 RECURSIVAMENTE (até maxNivel) para
// produtos PA/PI, anexa última compra (SD1+SF1) e histórico de variação.
//
// Componentes PI com estrutura própria recebem `subComponentes`, permitindo
// vista totalmente explodida de toda a árvore de materiais. O custo total
// do PA é calculado apenas no 1º nível (componentes diretos) para não dobrar
// valores — os subcomponentes são exibidos para fins de composição/análise.

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);
const MAX_NIVEL = 5;

module.exports = (app) => ({
  verb: 'get',
  route: '/custo/:produto',

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const produto = trim(req.params.produto).toUpperCase();
    const hoje = new Date();
    const hojeYmd = `${hoje.getFullYear()}${String(hoje.getMonth()+1).padStart(2,'0')}${String(hoje.getDate()).padStart(2,'0')}`;
    const histMeses = Math.min(Math.max(Number(req.query.histMeses || 12), 1), 36);
    const histIni = new Date(hoje.getFullYear(), hoje.getMonth() - histMeses, 1);
    const histIniYmd = `${histIni.getFullYear()}${String(histIni.getMonth()+1).padStart(2,'0')}01`;

    if (!produto) return res.status(400).json({ message: 'Código de produto é obrigatório.' });

    try {
      // 1) Dados do produto
      // Custo médio vem de SB2 (estoque por armazém). Pegamos o maior CM1 entre
      // armazéns da filial 01 — na prática todos costumam ter o mesmo valor.
      const prod = await Protheus.connectAndQuery(
        `SELECT TOP 1 RTRIM(sb1.B1_COD) cod, RTRIM(sb1.B1_DESC) descricao, RTRIM(sb1.B1_TIPO) tipo,
                RTRIM(sb1.B1_UM) um, sb1.B1_CUSTD custoPadrao, ISNULL(cm.cm1, 0) custoMedio,
                RTRIM(sb1.B1_POSIPI) ncm, RTRIM(sb1.B1_GRUPO) grupo, RTRIM(sb1.B1_PROC) tipoProc
           FROM SB1010 sb1 WITH (NOLOCK)
           LEFT JOIN (
             SELECT RTRIM(B2_COD) cod, MAX(B2_CM1) cm1
               FROM SB2010 WITH (NOLOCK)
              WHERE D_E_L_E_T_ <> '*' AND B2_FILIAL = '01'
              GROUP BY B2_COD
           ) cm ON cm.cod = RTRIM(sb1.B1_COD)
          WHERE sb1.D_E_L_E_T_ <> '*' AND sb1.B1_COD = @produto`,
        { produto }
      );
      if (!prod.length) return res.status(404).json({ message: 'Produto não encontrado.' });
      const p = prod[0];

      // 2) Explosão iterativa por níveis
      //    estrutura[pai] = [{ componente, descricao, tipo, um, qtd, perda, custoPadrao, nivel }]
      const porPai  = new Map();
      const todosCods = new Set();
      let paisAtuais = [produto];
      let nivel = 0;

      while (paisAtuais.length > 0 && nivel < MAX_NIVEL) {
        const paisUnicos = [...new Set(paisAtuais)].filter(c => !porPai.has(c));
        if (!paisUnicos.length) break;

        const inCods = paisUnicos.map((_, i) => `@pai${i}`).join(',');
        const params = { hoje: hojeYmd };
        paisUnicos.forEach((c, i) => { params[`pai${i}`] = c; });

        const rows = await Protheus.connectAndQuery(
          `SELECT RTRIM(sg1.G1_COD)   pai,
                  RTRIM(sg1.G1_COMP)  componente,
                  RTRIM(sb1.B1_DESC)  descricao,
                  RTRIM(sb1.B1_TIPO)  tipo,
                  RTRIM(sb1.B1_UM)    um,
                  sg1.G1_QUANT        qtd,
                  sg1.G1_PERDA        perda,
                  sb1.B1_CUSTD        custoPadrao,
                  ISNULL(cm.cm1, 0)   custoMedio
             FROM SG1010 sg1 WITH (NOLOCK)
             LEFT JOIN SB1010 sb1 WITH (NOLOCK)
               ON sb1.B1_COD = sg1.G1_COMP AND sb1.D_E_L_E_T_ <> '*'
             LEFT JOIN (
               SELECT RTRIM(B2_COD) cod, MAX(B2_CM1) cm1
                 FROM SB2010 WITH (NOLOCK)
                WHERE D_E_L_E_T_ <> '*' AND B2_FILIAL = '01'
                GROUP BY B2_COD
             ) cm ON cm.cod = RTRIM(sg1.G1_COMP)
            WHERE sg1.D_E_L_E_T_ <> '*'
              AND sg1.G1_COD IN (${inCods})
              AND sg1.G1_INI <= @hoje AND sg1.G1_FIM >= @hoje
            ORDER BY sg1.G1_COD, sg1.G1_COMP`,
          params
        );

        const proxPais = [];
        paisUnicos.forEach(pai => porPai.set(pai, []));
        rows.forEach(r => {
          const pai = trim(r.pai);
          const item = {
            componente: trim(r.componente),
            descricao: trim(r.descricao),
            tipo: trim(r.tipo),
            um: trim(r.um),
            qtd: toN(r.qtd),
            perda: toN(r.perda),
            custoPadrao: toN(r.custoPadrao),
            custoMedio: toN(r.custoMedio)
          };
          porPai.get(pai).push(item);
          todosCods.add(item.componente);
          if (item.tipo === 'PI' && !porPai.has(item.componente)) {
            proxPais.push(item.componente);
          }
        });

        paisAtuais = proxPais;
        nivel += 1;
      }

      const componentesRaiz = porPai.get(produto) || [];
      if (!componentesRaiz.length) {
        return res.json({
          produto: {
            cod: trim(p.cod), descricao: trim(p.descricao), tipo: trim(p.tipo),
            um: trim(p.um), custoPadrao: toN(p.custoPadrao), custoMedio: toN(p.custoMedio),
            ncm: trim(p.ncm), grupo: trim(p.grupo), tipoProc: trim(p.tipoProc)
          },
          aviso: 'Produto não tem estrutura (SG1) válida cadastrada para hoje.',
          componentes: [],
          historicoAgregado: [],
          totais: { custoComponentes: 0, impostosTotal: 0, custoTotal: 0, diffDoCustoPadrao: -toN(p.custoPadrao), qtdComponentes: 0 },
          parametros: { histMeses, histInicio: histIniYmd, maxNivel: MAX_NIVEL },
          geradoEm: new Date().toISOString()
        });
      }

      // 3) Buscar última compra e histórico de TODOS os componentes encontrados (qualquer nível)
      const todos = [...todosCods];
      const inTodos = todos.map((_, i) => `@c${i}`).join(',');
      const paramsCompra = {};
      todos.forEach((c, i) => { paramsCompra[`c${i}`] = c; });

      const ultCompra = todos.length ? await Protheus.connectAndQuery(
        `WITH ranked AS (
          SELECT RTRIM(sd1.D1_COD)     componente,
                 RTRIM(sd1.D1_DOC)     doc,
                 RTRIM(sd1.D1_SERIE)   serie,
                 RTRIM(sd1.D1_FORNECE) fornece,
                 RTRIM(sd1.D1_LOJA)    loja,
                 RTRIM(sa2.A2_NOME)    fornecedor,
                 RTRIM(sa2.A2_NREDUZ)  fornecedorFantasia,
                 sf1.F1_EMISSAO        emissao,
                 sd1.D1_QUANT          qtdComprada,
                 sd1.D1_VUNIT          vunit,
                 sd1.D1_TOTAL          total,
                 sd1.D1_VALICM         icms,
                 sd1.D1_VALIPI         ipi,
                 sd1.D1_VALIMP5        pis,
                 sd1.D1_VALIMP6        cofins,
                 sd1.D1_DESC           desconto,
                 RTRIM(sd1.D1_CF)      cfop,
                 ROW_NUMBER() OVER (PARTITION BY sd1.D1_COD ORDER BY sf1.F1_EMISSAO DESC, sd1.R_E_C_N_O_ DESC) rn
            FROM SD1010 sd1 WITH (NOLOCK)
           INNER JOIN SF1010 sf1 WITH (NOLOCK)
              ON sf1.F1_FILIAL  = sd1.D1_FILIAL
             AND sf1.F1_DOC     = sd1.D1_DOC
             AND sf1.F1_SERIE   = sd1.D1_SERIE
             AND sf1.F1_FORNECE = sd1.D1_FORNECE
             AND sf1.F1_LOJA    = sd1.D1_LOJA
             AND sf1.D_E_L_E_T_ <> '*'
             AND RTRIM(sf1.F1_TIPO) NOT IN ('D')
            LEFT JOIN SA2010 sa2 WITH (NOLOCK)
              ON sa2.A2_COD  = sd1.D1_FORNECE
             AND sa2.A2_LOJA = sd1.D1_LOJA
             AND sa2.D_E_L_E_T_ <> '*'
           WHERE sd1.D_E_L_E_T_ <> '*'
             AND sd1.D1_COD IN (${inTodos})
             AND sd1.D1_QUANT > 0
        )
        SELECT * FROM ranked WHERE rn = 1`,
        paramsCompra
      ) : [];

      const mapUlt = new Map();
      ultCompra.forEach(u => mapUlt.set(trim(u.componente), u));

      // 4) Histórico (usado para gráfico e variação por componente)
      const paramsHist = { histIni: histIniYmd, ...paramsCompra };
      const hist = todos.length ? await Protheus.connectAndQuery(
        `SELECT RTRIM(sd1.D1_COD)     componente,
                RTRIM(sd1.D1_DOC)     doc,
                RTRIM(sd1.D1_SERIE)   serie,
                RTRIM(sa2.A2_NREDUZ)  fornecedorFantasia,
                sf1.F1_EMISSAO        emissao,
                sd1.D1_QUANT          qtd,
                sd1.D1_VUNIT          vunit,
                sd1.D1_TOTAL          total
           FROM SD1010 sd1 WITH (NOLOCK)
          INNER JOIN SF1010 sf1 WITH (NOLOCK)
             ON sf1.F1_FILIAL  = sd1.D1_FILIAL
            AND sf1.F1_DOC     = sd1.D1_DOC
            AND sf1.F1_SERIE   = sd1.D1_SERIE
            AND sf1.F1_FORNECE = sd1.D1_FORNECE
            AND sf1.F1_LOJA    = sd1.D1_LOJA
            AND sf1.D_E_L_E_T_ <> '*'
            AND RTRIM(sf1.F1_TIPO) NOT IN ('D')
            AND sf1.F1_EMISSAO >= @histIni
           LEFT JOIN SA2010 sa2 WITH (NOLOCK)
             ON sa2.A2_COD  = sd1.D1_FORNECE
            AND sa2.A2_LOJA = sd1.D1_LOJA
            AND sa2.D_E_L_E_T_ <> '*'
          WHERE sd1.D_E_L_E_T_ <> '*'
            AND sd1.D1_COD IN (${inTodos})
            AND sd1.D1_QUANT > 0
          ORDER BY sd1.D1_COD, sf1.F1_EMISSAO ASC`,
        paramsHist
      ) : [];

      const histByComp = {};
      hist.forEach(h => {
        const k = trim(h.componente);
        if (!histByComp[k]) histByComp[k] = [];
        histByComp[k].push({
          emissao: trim(h.emissao),
          doc: trim(h.doc),
          serie: trim(h.serie),
          fornecedor: trim(h.fornecedorFantasia),
          qtd: toN(h.qtd),
          vunit: toN(h.vunit),
          total: toN(h.total)
        });
      });

      // 5) Monta árvore recursivamente. `fator` acumula quantidade efetiva ao descer.
      const montar = (codPai, fatorPai = 1, profundidade = 0) => {
        const itens = porPai.get(codPai) || [];
        return itens.map(c => {
          const cod = c.componente;
          const qtdEfetiva = c.qtd * (1 + c.perda); // aplica perda percentual
          const fator = qtdEfetiva * fatorPai;       // quanto vai no PA raiz
          const u = mapUlt.get(cod);

          let ultimaCompra = null;
          let custoReal = c.custoPadrao;
          let impostos = 0;

          if (u) {
            const vu     = toN(u.vunit);
            const qtdCp  = toN(u.qtdComprada);
            const icms   = toN(u.icms);
            const ipi    = toN(u.ipi);
            const pis    = toN(u.pis);
            const cofins = toN(u.cofins);
            const totalNF = toN(u.total);
            const impPorUnid = qtdCp > 0 ? (icms + ipi + pis + cofins) / qtdCp : 0;
            impostos  = impPorUnid * qtdEfetiva;  // impostos por unidade produzida pelo pai
            custoReal = vu * qtdEfetiva;

            ultimaCompra = {
              emissao: trim(u.emissao),
              nfDoc: trim(u.doc),
              nfSerie: trim(u.serie),
              fornecedorCod: trim(u.fornece),
              fornecedorLoja: trim(u.loja),
              fornecedor: trim(u.fornecedor),
              fornecedorFantasia: trim(u.fornecedorFantasia),
              qtdComprada: qtdCp,
              vunit: vu,
              totalItem: totalNF,
              icms, ipi, pis, cofins,
              desconto: toN(u.desconto),
              cfop: trim(u.cfop),
              impostoUnitario: impPorUnid
            };
          }

          const historico = histByComp[cod] || [];
          let variacao = null;
          if (historico.length >= 2) {
            const primeiro = historico[0].vunit;
            const ultimo   = historico[historico.length - 1].vunit;
            if (primeiro > 0) variacao = ((ultimo - primeiro) / primeiro) * 100;
          }

          // Recursivamente explode se o componente é PI e tem sub-estrutura
          const subComponentes = (c.tipo === 'PI' && porPai.has(cod) && porPai.get(cod).length > 0 && profundidade < MAX_NIVEL)
            ? montar(cod, fator, profundidade + 1)
            : [];

          return {
            componente: cod,
            descricao: c.descricao,
            tipo: c.tipo,
            um: c.um,
            qtd: c.qtd,
            perda: c.perda,
            qtdComPerda: qtdEfetiva,
            qtdEfetivaNoPA: fator,
            custoPadrao: c.custoPadrao,
            custoMedio: c.custoMedio,
            custoReal,
            impostos,
            custoComImpostos: custoReal + impostos,
            ultimaCompra,
            historico,
            qtdHistorico: historico.length,
            variacaoPercentual: variacao,
            temSubEstrutura: subComponentes.length > 0,
            subComponentes,
            nivel: profundidade
          };
        });
      };

      const componentes = montar(produto, 1, 0).sort((a, b) => (b.custoReal || 0) - (a.custoReal || 0));

      // 6) Totais — somam apenas o 1º nível (árvore explodida é só pra detalhamento visual)
      const custoComponentes = componentes.reduce((s, c) => s + (c.custoReal || 0), 0);
      const impostosTotal    = componentes.reduce((s, c) => s + (c.impostos || 0), 0);

      // 7) Histórico agregado por mês (para gráfico — mantido pra compatibilidade)
      const aggMes = {};
      hist.forEach(h => {
        const ym = trim(h.emissao).slice(0, 6);
        if (!aggMes[ym]) aggMes[ym] = { mes: ym, qtd: 0, valor: 0, nLancam: 0 };
        aggMes[ym].qtd    += toN(h.qtd);
        aggMes[ym].valor  += toN(h.total);
        aggMes[ym].nLancam += 1;
      });
      const historicoAgregado = Object.values(aggMes)
        .sort((a, b) => a.mes.localeCompare(b.mes))
        .map(m => ({
          mes: m.mes,
          label: `${m.mes.slice(4, 6)}/${m.mes.slice(0, 4)}`,
          qtd: m.qtd,
          valor: m.valor,
          vunitMedio: m.qtd > 0 ? m.valor / m.qtd : 0,
          lancamentos: m.nLancam
        }));

      // 8) Top variacoes (unitario e total) — apenas componentes com >=2 compras.
      // Calcula variacao % entre primeira e ultima compra do periodo.
      const variacoes = todos.map(cod => {
        const h = histByComp[cod] || [];
        if (h.length < 2) return null;
        const primeiro = h[0];
        const ultimo   = h[h.length - 1];
        const vunitPct = primeiro.vunit > 0 ? ((ultimo.vunit - primeiro.vunit) / primeiro.vunit) * 100 : 0;
        const totalPct = primeiro.total > 0 ? ((ultimo.total - primeiro.total) / primeiro.total) * 100 : 0;
        // Encontra descricao em algum lugar da arvore
        let descricao = cod;
        for (const arr of porPai.values()) {
          const f = arr.find(x => x.componente === cod);
          if (f) { descricao = f.descricao; break; }
        }
        return {
          componente: cod, descricao,
          primeira: { emissao: primeiro.emissao, vunit: primeiro.vunit, total: primeiro.total, qtd: primeiro.qtd },
          ultima:   { emissao: ultimo.emissao,   vunit: ultimo.vunit,   total: ultimo.total,   qtd: ultimo.qtd },
          deltaVunit: ultimo.vunit - primeiro.vunit,
          deltaTotal: ultimo.total - primeiro.total,
          variacaoPctVunit: vunitPct,
          variacaoPctTotal: totalPct,
          qtdCompras: h.length,
          historico: h.map(x => ({ emissao: x.emissao, vunit: x.vunit, total: x.total, qtd: x.qtd }))
        };
      }).filter(Boolean);

      const topVariacaoUnitario = [...variacoes]
        .sort((a, b) => Math.abs(b.variacaoPctVunit) - Math.abs(a.variacaoPctVunit))
        .slice(0, 5);
      const topVariacaoTotal = [...variacoes]
        .sort((a, b) => Math.abs(b.variacaoPctTotal) - Math.abs(a.variacaoPctTotal))
        .slice(0, 5);

      return res.json({
        produto: {
          cod: trim(p.cod),
          descricao: trim(p.descricao),
          tipo: trim(p.tipo),
          um: trim(p.um),
          custoPadrao: toN(p.custoPadrao),
          custoMedio: toN(p.custoMedio),
          ncm: trim(p.ncm),
          grupo: trim(p.grupo),
          tipoProc: trim(p.tipoProc)
        },
        componentes,
        totais: {
          custoComponentes,
          impostosTotal,
          custoTotal: custoComponentes + impostosTotal,
          diffDoCustoPadrao: (custoComponentes + impostosTotal) - toN(p.custoPadrao),
          qtdComponentes: componentes.length
        },
        historicoAgregado,
        topVariacao: { unitario: topVariacaoUnitario, total: topVariacaoTotal },
        parametros: { histMeses, histInicio: histIniYmd, maxNivel: MAX_NIVEL },
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro controladoria/custo:', err);
      return res.status(500).json({ message: 'Erro ao calcular custo.' });
    }
  }
});

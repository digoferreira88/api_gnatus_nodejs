// DRE Gerencial — regime competência por emissão.
//
// Receitas    : SF2010 + SD2010 com CFOP de venda no período
// Deduções    : impostos (SD2) + devoluções (SF1 + SD1 com CFOP de entrada por devolução)
// CMV         : SUM(SD2.D2_CUSTO1) nas linhas de venda
// Despesas    : SE2010 emitidas no período, agrupadas por natureza-pai (3 primeiros
//               caracteres do ED_CODIGO). Descrições vêm de SED010.
// Financeiro  : natureza prefixo '211'
// Impostos    : natureza prefixo '208'
//
// Todas as queries filtram D_E_L_E_T_ <> '*' e F_FILIAL = '01' e usam (NOLOCK).

// CFOPs de venda para reconhecimento de receita no DRE.
// Base: lista oficial Gnatus (20 CFOPs SP+FORA usadas no relatório de faturamento)
// + 5907/6907 (faturamento futuro — receita reconhecida) + 5924 (outras saídas).
// Excluídos 5934 (remessa simbólica) e 5914 (retorno de remessa em consignação)
// porque são operações simbólicas que não geram receita real.
const CFOPS_VENDA = ['5105','5106','5116','5117','5119','5405','5933',
                     '6105','6106','6107','6108','6109','6110','6116','6117',
                     '6119','6122','6123','6404','6933','5907','6907','5924'];

const CFOPS_DEVOLUCAO = ['1202','2202','1411','2411','1553','2553'];

// ---------- AGRUPADOR: NATUREZA (gerencial) ----------
// Classificação dos prefixos de natureza em linhas do DRE.
// IMPORTANTE: 201/202/203 (MP Nacional/Importada/Desembaraço) NÃO entram em
// Despesas Operacionais — esses custos são absorvidos via CMV (D2_CUSTO1)
// quando o PA correspondente é vendido. Somá-los aqui causaria double-counting.
const MAPA_DESPESAS = {
  '204': { ordem: 1, label: 'Serviços Tomados' },
  '205': { ordem: 2, label: 'Despesas com Pessoal' },
  '206': { ordem: 3, label: 'Despesas Gerais' },
  '207': { ordem: 4, label: 'Despesas Administrativas' },
  '210': { ordem: 5, label: 'Investimentos' },
  '212': { ordem: 6, label: 'Sócios' },
  '213': { ordem: 7, label: 'Imobilizado/Consórcio' }
};
const MAPA_INSUMOS = {
  '201': { ordem: 1, label: 'Matéria-Prima Nacional' },
  '202': { ordem: 2, label: 'Matéria-Prima Importada' },
  '203': { ordem: 3, label: 'Desembaraço Aduaneiro' }
};
const GRUPO_FINANCEIRO = '211';
const GRUPO_IMPOSTOS   = '208';

// ---------- AGRUPADOR: CONTA CONTÁBIL (contabil) ----------
// Plano de contas Gnatus (formato 11 chars):
//   1xxx = Ativo (NÃO entra no DRE)
//   2xxx = Passivo (NÃO entra no DRE)
//   3xxx = Receita (vem da SD2.D2_CONTA)
//   4xxx = Despesas/Custos (vem da SE2.E2_CONTAD)
//
// Despesas (SE2.E2_CONTAD) — agrupadas por prefixo 4 chars:
const MAPA_DESPESAS_CONTA = {
  '4110': { ordem: 1, label: 'Despesas Operacionais' },
  '4120': { ordem: 2, label: 'Outras Despesas Operacionais' }
};
const GRUPO_FINANCEIRO_CONTA = '4140';   // Despesas Financeiras
// Títulos com conta começando com 1xxx ou 2xxx são Ativo/Passivo (não vão
// pro DRE) — listamos em "outrasDespesas" só pra controle.

// Classificação heurística da natureza 211 (Financeiro). Como a Gnatus não
// subdivide a natureza no Protheus (tudo cai em 21101), inferimos pelo
// histórico do título. Auditoria mostrou que ~44% é amortização de
// financiamento (não vai pro DRE), ~2% juros reais e ~54% sem padrão claro.
const RX_AMORTIZACAO = /AMORTIZ|FINIMP|PRINCIPAL|INVOICE|RECOMPRA/i;
const RX_JUROS_REAL  = /JUROS|IOF|TAXA|TARIFA|CUSTAS|MULTA|MORA|CORRETAGEM/i;

const classificar211 = (historico) => {
  const h = String(historico || '');
  if (RX_AMORTIZACAO.test(h)) return 'AMORTIZACAO';
  if (RX_JUROS_REAL.test(h))  return 'JUROS';
  return 'PENDENTE';
};

const toN = (v) => Number(v || 0);
const trim = (v) => String(v || '').trim();

// Constrói a cláusula IN parametrizada
const buildInClause = (list, prefix) => {
  const keys = list.map((_, i) => `@${prefix}${i}`);
  const params = {};
  list.forEach((v, i) => { params[`${prefix}${i}`] = v; });
  return { sql: keys.join(','), params };
};

module.exports = (app) => ({
  verb: 'get',
  route: '/dre',
  // Perm 10001 (12/08/2026): estava sem requirePerm — qualquer logado puxava o DRE
  // inteiro via API. Ficou critico com a perm 10003 (gestor restrito): ele NAO pode
  // ter acesso a esta visao completa, so ao /dre/centro-custo com escopo.
  middlewares: [require('../../middlewares/requirePerm')(app)([10001])],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const inicio = trim(req.query.inicio); // YYYYMMDD
    const fim    = trim(req.query.fim);
    const agrupador = (trim(req.query.agrupador) || 'natureza').toLowerCase();
    if (!['natureza', 'conta'].includes(agrupador)) {
      return res.status(400).json({ message: 'agrupador deve ser "natureza" ou "conta".' });
    }
    const porConta = agrupador === 'conta';

    if (!/^\d{8}$/.test(inicio) || !/^\d{8}$/.test(fim)) {
      return res.status(400).json({ message: 'Parâmetros inicio/fim devem ser YYYYMMDD.' });
    }

    try {
      const filial = '01';

      // ---------- 1) Receita bruta + impostos + CMV (SD2 + SF2) ----------
      const vendaIn = buildInClause(CFOPS_VENDA, 'cv');
      const sqlReceita = `
        SELECT RTRIM(D2_CF) cfop,
               COUNT(*)        qtd,
               SUM(D2_TOTAL)   total,
               SUM(D2_VALICM)  icms,
               SUM(D2_VALIPI)  ipi,
               SUM(D2_VALIMP5) pis,
               SUM(D2_VALIMP6) cofins,
               SUM(D2_CUSTO1)  cmv,
               SUM(D2_DESCON)  desconto,
               SUM(D2_VALDEV)  valdev
          FROM SD2010 sd2 WITH (NOLOCK)
         INNER JOIN SF2010 sf2 WITH (NOLOCK)
            ON sf2.F2_FILIAL = sd2.D2_FILIAL
           AND sf2.F2_DOC    = sd2.D2_DOC
           AND sf2.F2_SERIE  = sd2.D2_SERIE
           AND sf2.F2_CLIENTE = sd2.D2_CLIENTE
           AND sf2.F2_LOJA    = sd2.D2_LOJA
           AND sf2.D_E_L_E_T_ <> '*'
         WHERE sd2.D_E_L_E_T_ <> '*'
           AND sd2.D2_FILIAL = @filial
           AND sd2.D2_EMISSAO BETWEEN @inicio AND @fim
           AND sf2.F2_EMISSAO BETWEEN @inicio AND @fim
           AND RTRIM(sd2.D2_CF) IN (${vendaIn.sql})
         GROUP BY sd2.D2_CF
         ORDER BY SUM(D2_TOTAL) DESC
      `;
      const receitaRows = await Protheus.connectAndQuery(sqlReceita, { filial, inicio, fim, ...vendaIn.params });

      const receitaBruta = { detalhes: [], total: 0 };
      let icms = 0, ipi = 0, pis = 0, cofins = 0, cmv = 0, desconto = 0, valdevLinha = 0;
      receitaRows.forEach(r => {
        const total = toN(r.total);
        receitaBruta.detalhes.push({ cfop: trim(r.cfop), qtd: toN(r.qtd), valor: total });
        receitaBruta.total += total;
        icms   += toN(r.icms);
        ipi    += toN(r.ipi);
        pis    += toN(r.pis);
        cofins += toN(r.cofins);
        cmv    += toN(r.cmv);
        desconto   += toN(r.desconto);
        valdevLinha += toN(r.valdev);
      });

      // ---------- 2) Devoluções (SF1 + SD1 CFOPs de entrada) ----------
      const devIn = buildInClause(CFOPS_DEVOLUCAO, 'cd');
      const sqlDev = `
        SELECT RTRIM(D1_CF) cfop, COUNT(*) qtd, SUM(D1_TOTAL) total
          FROM SD1010 sd1 WITH (NOLOCK)
         INNER JOIN SF1010 sf1 WITH (NOLOCK)
            ON sf1.F1_FILIAL = sd1.D1_FILIAL
           AND sf1.F1_DOC    = sd1.D1_DOC
           AND sf1.F1_SERIE  = sd1.D1_SERIE
           AND sf1.F1_FORNECE = sd1.D1_FORNECE
           AND sf1.F1_LOJA    = sd1.D1_LOJA
           AND sf1.D_E_L_E_T_ <> '*'
         WHERE sd1.D_E_L_E_T_ <> '*'
           AND sd1.D1_FILIAL = @filial
           AND sd1.D1_EMISSAO BETWEEN @inicio AND @fim
           AND sf1.F1_EMISSAO BETWEEN @inicio AND @fim
           AND RTRIM(sd1.D1_CF) IN (${devIn.sql})
         GROUP BY sd1.D1_CF
      `;
      const devRows = await Protheus.connectAndQuery(sqlDev, { filial, inicio, fim, ...devIn.params });
      const devolucoes = { total: 0, detalhes: [] };
      devRows.forEach(r => {
        const v = toN(r.total);
        devolucoes.detalhes.push({ cfop: trim(r.cfop), qtd: toN(r.qtd), valor: v });
        devolucoes.total += v;
      });

      // ---------- 3) Despesas (SE2) — agrupadas por natureza OU conta contabil ----------
      // Quando agrupador = 'natureza': agrupa por SE2.E2_NATUREZ (visao gerencial)
      // Quando agrupador = 'conta': agrupa por SE2.E2_CONTAD (visao contabil — bate com a contabilidade)
      //
      // IMPORTANTE no modo conta: excluimos titulos de naturezas 201/202/203
      // (Materia-Prima Nacional/Importada/Desembaraco). Eles podem ter conta
      // 4110 (Despesas Operacionais) lancada na SE2, mas a contabilidade trata
      // MP como ESTOQUE -> CMV. Incluir aqui causaria double-counting com o
      // CMV que ja vem da SD2.D2_CUSTO1.
      const sqlDespesas = porConta
        ? `
        SELECT RTRIM(se2.E2_CONTAD) natureza,
               MAX(RTRIM(ct1.CT1_DESC01)) descricao,
               COUNT(*) qtd,
               SUM(se2.E2_VALOR) valor
          FROM SE2010 se2 WITH (NOLOCK)
          LEFT JOIN CT1010 ct1 WITH (NOLOCK)
            ON RTRIM(ct1.CT1_CONTA) = RTRIM(se2.E2_CONTAD)
           AND ct1.D_E_L_E_T_ <> '*'
         WHERE se2.D_E_L_E_T_ <> '*'
           AND se2.E2_FILIAL = @filial
           AND se2.E2_EMISSAO BETWEEN @inicio AND @fim
           AND RTRIM(se2.E2_CONTAD) <> ''
           AND LEFT(RTRIM(se2.E2_NATUREZ), 3) NOT IN ('201','202','203')
         GROUP BY se2.E2_CONTAD
         ORDER BY SUM(se2.E2_VALOR) DESC
      `
        : `
        SELECT RTRIM(se2.E2_NATUREZ) natureza,
               MAX(RTRIM(sed.ED_DESCRIC)) descricao,
               COUNT(*) qtd,
               SUM(se2.E2_VALOR) valor
          FROM SE2010 se2 WITH (NOLOCK)
          LEFT JOIN SED010 sed WITH (NOLOCK)
            ON sed.ED_CODIGO = se2.E2_NATUREZ
           AND sed.D_E_L_E_T_ <> '*'
         WHERE se2.D_E_L_E_T_ <> '*'
           AND se2.E2_FILIAL = @filial
           AND se2.E2_EMISSAO BETWEEN @inicio AND @fim
         GROUP BY se2.E2_NATUREZ
         ORDER BY SUM(se2.E2_VALOR) DESC
      `;
      const despesasRows = await Protheus.connectAndQuery(sqlDespesas, { filial, inicio, fim });

      // ---------- 3.1) Detalhes da natureza 211 (Financeiro) — classifica
      // título a título por palavras-chave do histórico.
      // Heurística necessária porque a Gnatus tem só 21101 cadastrada (mistura
      // amortização de empréstimos com juros reais). Auditoria gerada na rota
      // /gerencia/dre/auditoria-211 lista cada lançamento para a contabilidade
      // reclassificar no Protheus.
      // Filtra titulos de Financeiro: prefixo natureza '211' OU prefixo conta '4140'
      // No modo conta, exclui MP (mesma regra de cima — evita double-counting com CMV)
      const filtroFinanc = porConta
        ? `LEFT(RTRIM(se2.E2_CONTAD), 4) = '${GRUPO_FINANCEIRO_CONTA}' AND LEFT(RTRIM(se2.E2_NATUREZ), 3) NOT IN ('201','202','203')`
        : `LEFT(RTRIM(se2.E2_NATUREZ), 3) = '${GRUPO_FINANCEIRO}'`;
      const sql211 = `
        SELECT RTRIM(se2.E2_NATUREZ) natureza,
               RTRIM(se2.E2_CONTAD)  conta,
               RTRIM(se2.E2_PREFIXO) prefixo,
               RTRIM(se2.E2_NUM)     numero,
               RTRIM(se2.E2_PARCELA) parcela,
               RTRIM(se2.E2_TIPO)    tipoTitulo,
               RTRIM(se2.E2_FORNECE) fornCod,
               RTRIM(se2.E2_LOJA)    fornLoja,
               RTRIM(se2.E2_NOMFOR)  fornNome,
               RTRIM(se2.E2_HIST)    historico,
               se2.E2_EMISSAO        emissao,
               se2.E2_VENCTO         vencimento,
               se2.E2_VALOR          valor
          FROM SE2010 se2 WITH (NOLOCK)
         WHERE se2.D_E_L_E_T_ <> '*'
           AND se2.E2_FILIAL = @filial
           AND se2.E2_EMISSAO BETWEEN @inicio AND @fim
           AND ${filtroFinanc}
         ORDER BY se2.E2_VALOR DESC
      `;
      const titulos211 = await Protheus.connectAndQuery(sql211, { filial, inicio, fim });

      const fin211 = { juros: { total: 0, qtd: 0, lancamentos: [] },
                       amortizacao: { total: 0, qtd: 0, lancamentos: [] },
                       pendente:    { total: 0, qtd: 0, lancamentos: [] } };
      titulos211.forEach(r => {
        const valor = toN(r.valor);
        if (valor === 0) return;
        const cls = classificar211(r.historico);
        const bucket = cls === 'AMORTIZACAO' ? fin211.amortizacao
                     : cls === 'JUROS'       ? fin211.juros
                     :                         fin211.pendente;
        bucket.total += valor;
        bucket.qtd   += 1;
        bucket.lancamentos.push({
          natureza: trim(r.natureza),
          prefixo: trim(r.prefixo),
          numero: trim(r.numero),
          parcela: trim(r.parcela),
          tipoTitulo: trim(r.tipoTitulo),
          fornCod: trim(r.fornCod),
          fornLoja: trim(r.fornLoja),
          fornNome: trim(r.fornNome),
          historico: trim(r.historico),
          emissao: trim(r.emissao),
          vencimento: trim(r.vencimento),
          valor,
          classificacao: cls
        });
      });

      // Agrupa por prefixo de 3 chars (natureza-pai)
      const gruposDespesas = {};      // despesas operacionais (entram em EBIT)
      const gruposInsumos  = {};      // 201/202/203 — informativo, NÃO entram em EBIT
      let totalImpostos = 0;          // prefixo 208
      const detalhesImpostos = [];
      const outrasDespesas = [];      // naturezas que não entram em nenhum grupo

      // Classificação varia conforme agrupador.
      // Natureza: prefixo 3 chars (204, 205, 211, 208, etc)
      // Conta:    prefixo 4 chars (4110, 4140, etc — só 4xxx entra no DRE)
      const tamPref = porConta ? 4 : 3;
      const grupoFinanceiro = porConta ? GRUPO_FINANCEIRO_CONTA : GRUPO_FINANCEIRO;
      const mapaDespesas = porConta ? MAPA_DESPESAS_CONTA : MAPA_DESPESAS;

      despesasRows.forEach(r => {
        const cod = trim(r.natureza);   // 'natureza' aqui pode ser conta tb (alias do SQL)
        const descricao = trim(r.descricao) || '(sem descrição)';
        const valor = toN(r.valor);
        const qtd = toN(r.qtd);
        if (!cod || valor === 0) return;

        const pref = cod.slice(0, tamPref);

        // Financeiro ja foi tratado em sql211 acima — pula
        if (pref === grupoFinanceiro) return;

        if (porConta) {
          // Modo CONTA: prefixos 1xxx (Ativo) e 2xxx (Passivo) NÃO entram no DRE
          // Esses são titulos como adiantamento a fornecedor, emprestimo bancario, tributos a recolher
          // Ficam em "outrasDespesas" só pra controle (informativo)
          const primeiroDigito = cod.slice(0, 1);
          if (primeiroDigito === '1' || primeiroDigito === '2') {
            outrasDespesas.push({ natureza: cod, descricao, qtd, valor });
            return;
          }

          if (mapaDespesas[pref]) {
            if (!gruposDespesas[pref]) {
              gruposDespesas[pref] = {
                codigo: pref, label: mapaDespesas[pref].label, ordem: mapaDespesas[pref].ordem,
                total: 0, naturezas: []
              };
            }
            gruposDespesas[pref].total += valor;
            gruposDespesas[pref].naturezas.push({ natureza: cod, descricao, qtd, valor });
          } else {
            // Conta 4xxx fora do mapa — agrupa em "Outras Despesas Operacionais"
            const generic = '4OUT';
            if (!gruposDespesas[generic]) {
              gruposDespesas[generic] = {
                codigo: generic, label: 'Outras Despesas (não classificadas)', ordem: 99,
                total: 0, naturezas: []
              };
            }
            gruposDespesas[generic].total += valor;
            gruposDespesas[generic].naturezas.push({ natureza: cod, descricao, qtd, valor });
          }
          return;
        }

        // ===== Modo NATUREZA =====
        if (pref === GRUPO_IMPOSTOS) {
          totalImpostos += valor;
          detalhesImpostos.push({ natureza: cod, descricao, qtd, valor });
          return;
        }

        // 201/202/203 são compras de insumos — agrupar separado e NÃO somar em EBIT
        if (MAPA_INSUMOS[pref]) {
          if (!gruposInsumos[pref]) {
            gruposInsumos[pref] = {
              codigo: pref, label: MAPA_INSUMOS[pref].label, ordem: MAPA_INSUMOS[pref].ordem,
              total: 0, naturezas: []
            };
          }
          gruposInsumos[pref].total += valor;
          gruposInsumos[pref].naturezas.push({ natureza: cod, descricao, qtd, valor });
          return;
        }

        if (MAPA_DESPESAS[pref]) {
          if (!gruposDespesas[pref]) {
            gruposDespesas[pref] = {
              codigo: pref, label: MAPA_DESPESAS[pref].label, ordem: MAPA_DESPESAS[pref].ordem,
              total: 0, naturezas: []
            };
          }
          gruposDespesas[pref].total += valor;
          gruposDespesas[pref].naturezas.push({ natureza: cod, descricao, qtd, valor });
        } else {
          outrasDespesas.push({ natureza: cod, descricao, qtd, valor });
        }
      });

      const gruposArr = Object.values(gruposDespesas).sort((a, b) => a.ordem - b.ordem);
      const insumosArr = Object.values(gruposInsumos).sort((a, b) => a.ordem - b.ordem);
      const totalDespesasOp = gruposArr.reduce((s, g) => s + g.total, 0);
      const totalInsumos    = insumosArr.reduce((s, g) => s + g.total, 0);
      const totalOutras = outrasDespesas.reduce((s, n) => s + n.valor, 0);

      // ---------- 4) Consolidação DRE ----------
      // Apenas JUROS confirmados entram no Resultado Financeiro do DRE.
      // Amortização e Pendente saem como informativo (não impactam Lucro Líquido).
      const totalDeducoes = devolucoes.total + icms + pis + cofins + ipi;
      const receitaLiquida = receitaBruta.total - totalDeducoes;
      const lucroBruto = receitaLiquida - cmv;
      const ebit = lucroBruto - totalDespesasOp;
      const totalFinanceiroReal = fin211.juros.total;
      const lucroLiquido = ebit - totalFinanceiroReal - totalImpostos - totalOutras;

      const pct = (v) => (receitaLiquida > 0 ? (v / receitaLiquida) * 100 : 0);

      return res.json({
        periodo: { inicio, fim },
        agrupador,
        geradoEm: new Date().toISOString(),

        receitaBruta: { total: receitaBruta.total, detalhes: receitaBruta.detalhes },

        deducoes: {
          total: totalDeducoes,
          devolucoes: { total: devolucoes.total, detalhes: devolucoes.detalhes },
          icms, pis, cofins, ipi
        },

        receitaLiquida,

        cmv: { total: cmv },

        lucroBruto,
        margemBruta: pct(lucroBruto),

        despesasOperacionais: {
          total: totalDespesasOp,
          grupos: gruposArr
        },

        comprasInsumos: {
          total: totalInsumos,
          grupos: insumosArr,
          aviso: 'Informativo. Não impacta EBIT/Lucro Líquido — esses custos são absorvidos via CMV quando o produto correspondente é vendido.'
        },

        ebit,
        margemOperacional: pct(ebit),

        // Apenas juros/IOF/taxas confirmados — entram no Lucro Líquido
        resultadoFinanceiro: {
          total: fin211.juros.total,
          qtd: fin211.juros.qtd,
          aviso: 'Apenas lançamentos com histórico contendo JUROS, IOF, TAXA, TARIFA, CUSTAS, MULTA, MORA ou CORRETAGEM.'
        },

        // Informativo: amortização de financiamento (não vai pro DRE)
        amortizacaoFinanciamento: {
          total: fin211.amortizacao.total,
          qtd: fin211.amortizacao.qtd,
          aviso: 'Amortização de empréstimos / FINIMP / faturas de importação. NÃO impacta EBIT/Lucro Líquido — é redução de passivo, não despesa.'
        },

        // Informativo: lançamentos sem padrão claro pra contabilidade reclassificar
        pendenteClassificacao: {
          total: fin211.pendente.total,
          qtd: fin211.pendente.qtd,
          aviso: 'Lançamentos da natureza 211 sem palavra-chave reconhecível. Solicitar à contabilidade que reclassifique no Protheus criando subnaturezas (21102 Amortização, 21103 IOF, 21104 Importação, etc).'
        },

        impostosRecolher: { total: totalImpostos, detalhes: detalhesImpostos },
        outrasDespesas:   { total: totalOutras, naturezas: outrasDespesas },

        lucroLiquido,
        margemLiquida: pct(lucroLiquido),

        // metadados úteis pro frontend
        descontoBruto: desconto
      });
    } catch (err) {
      console.error('Erro em gerencia/dre:', err);
      return res.status(500).json({ message: 'Erro ao montar DRE.' });
    }
  }
});

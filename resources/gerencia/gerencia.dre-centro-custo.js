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
// FONTE POR MES (12/08/2026): mes ja CONTABILIZADO passa a sair do RAZAO (CT2010
// por CT2_CCD/CT2_CCC), nao mais de pedidos/titulos. Motivo: no fechamento a
// contabilidade reclassifica conta, rateia e lanca ajuste manual — o pedido de
// compra nao reflete nada disso, entao o gerencial divergia do contabil. Mes ainda
// EM ABERTO continua saindo de pedidos+titulos (indicador antecedente, chega antes
// da contabilizacao). Medicao que embasou: 202606 pelo razao = R$ 3,68 mi em 31 CCs
// contra R$ 3,26 mi em 23 CCs pelos pedidos; 202607 tinha 1% de cobertura de CC
// (mes nao fechado). Cada mes devolve sua `fonte` pro frontend deixar isso explicito.
//
// Perms: 10001 (visao completa, mesma do DRE Gerencial) OU 10003 (gestor restrito,
// enxerga so os CCs vinculados a ele e sem as contas de tab_dre_conta_oculta).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10001, 10003]);

const trim = (v) => String(v || '').trim();
const toN = (v) => Number(v || 0);

// Abaixo disso o mes e considerado NAO contabilizado (razao ainda nao lancado) e a
// fonte segue sendo pedidos/titulos. Mes fechado tem milhares de linhas com CC; mes
// aberto tem dezenas (202607 tinha 16). O limiar so precisa separar essas ordens de
// grandeza — nao e um numero fino.
const MIN_LINHAS_RAZAO = 50;

// Descobre, por mes do range, quantas linhas de despesa COM centro de custo ja
// existem no razao. Vazio/baixo = mes ainda nao contabilizado.
async function linhasRazaoPorMes(Protheus, inicio, fim) {
  const rows = await Protheus.connectAndQuery(`
    SELECT ymes, COUNT(*) linhas FROM (
      SELECT LEFT(CT2_DATA, 6) ymes
        FROM CT2010 WITH (NOLOCK)
       WHERE D_E_L_E_T_ <> '*' AND CT2_DATA BETWEEN @inicio AND @fim
         AND LEFT(RTRIM(CT2_DEBITO), 1) = '4'
         AND RTRIM(ISNULL(CT2_CCD, '')) <> ''
      UNION ALL
      SELECT LEFT(CT2_DATA, 6) ymes
        FROM CT2010 WITH (NOLOCK)
       WHERE D_E_L_E_T_ <> '*' AND CT2_DATA BETWEEN @inicio AND @fim
         AND LEFT(RTRIM(CT2_CREDIT), 1) = '4'
         AND RTRIM(ISNULL(CT2_CCC, '')) <> ''
    ) t GROUP BY ymes`, { inicio, fim });
  const m = new Map();
  rows.forEach(r => m.set(trim(r.ymes), toN(r.linhas)));
  return m;
}

// Escopo do usuario logado. Visao completa (perm 0 ou 10001) => sem restricao.
// So 10003 => restrito aos CCs vinculados, sem as contas ocultas.
// FALHA FECHADO: se as tabelas da migration 88 nao existirem, o restrito fica com
// escopo vazio (nao ve nada) em vez de vazar o DRE inteiro.
async function resolverEscopo(Pg, user) {
  const idUser = user && user.ID;
  const aberto = { restrito: false, ccs: null, contasOcultas: new Set() };
  if (!idUser) return aberto;

  const perms = await Pg.connectAndQuery(
    `SELECT id_permissao FROM tab_intranet_usr_permissoes
      WHERE id_user = @id AND id_permissao IN (0, 10001, 10003)`, { id: idUser });
  const tem = new Set(perms.map(p => Number(p.id_permissao)));
  if (tem.has(0) || tem.has(10001)) return aberto;

  const escopo = { restrito: true, ccs: new Set(), contasOcultas: new Set() };
  try {
    const ccRows = await Pg.connectAndQuery(
      `SELECT cc_codigo FROM tab_dre_cc_usuario WHERE id_user = @id`, { id: idUser });
    ccRows.forEach(r => escopo.ccs.add(trim(r.cc_codigo)));
  } catch (e) {
    console.warn('dre-centro-custo: tab_dre_cc_usuario indisponivel (migration 88?):', e.message);
  }
  try {
    const ctRows = await Pg.connectAndQuery(
      `SELECT conta FROM tab_dre_conta_oculta WHERE ativo`, {});
    ctRows.forEach(r => escopo.contasOcultas.add(trim(r.conta)));
  } catch (e) {
    console.warn('dre-centro-custo: tab_dre_conta_oculta indisponivel (migration 88?):', e.message);
  }
  return escopo;
}

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
      // 0) Escopo do usuario + fonte de cada mes do range.
      const escopo = await resolverEscopo(Pg, req.user && req.user[0]);
      const ccPermitido = (cc) => !escopo.restrito || escopo.ccs.has(trim(cc));
      const contaOculta = (conta) => escopo.restrito && escopo.contasOcultas.has(trim(conta));

      // Gestor restrito sem nenhum CC vinculado: devolve vazio com aviso, em vez de
      // cair no caminho normal (que mostraria tudo).
      if (escopo.restrito && escopo.ccs.size === 0) {
        return res.json({
          periodo: { inicio, fim },
          geradoEm: new Date().toISOString(),
          aviso: 'Seu usuario ainda nao tem centro de custo vinculado. Peca a TI para vincular na Gestao de Usuarios.',
          escopo: { restrito: true, centrosCusto: [], qtdContasOcultas: 0 },
          totais: { valorTotal: 0, qtdPedidos: 0, qtdItens: 0, qtdCentros: 0 },
          porCentroCusto: [], evolucaoMensal: [], fontePorMes: [],
          excluidos: { rejeitadosPC: 0, rejeitadosSC: 0 }
        });
      }

      const linhasRazao = await linhasRazaoPorMes(Protheus, inicio, fim);

      // Carrega o razao ANTES de montar a arvore. A ordem importa: um mes so e
      // declarado "fechado" (e portanto tem pedidos/titulos descartados) se o razao
      // dele realmente chegou. Se a consulta falhar, nenhum mes fecha e a visao
      // inteira cai de volta em pedidos+titulos — degrada, nao esvazia.
      const mesesFechadosOk = new Set();
      let razaoRows = [];
      const nomeForRazao = new Map();
      const candidatos = [...linhasRazao.entries()].filter(([, n]) => toN(n) >= MIN_LINHAS_RAZAO);
      if (candidatos.length) {
        try {
          razaoRows = await Protheus.connectAndQuery(`
            SELECT LEFT(CT2_DATA, 6) ymes, CT2_DATA data, RTRIM(CT2_CCD) cc,
                   RTRIM(CT2_DEBITO) conta, RTRIM(ISNULL(CT2_DOC, '')) doc,
                   RTRIM(ISNULL(CT2_LOTE, '')) lote, RTRIM(ISNULL(CT2_HIST, '')) hist,
                   RTRIM(ISNULL(CT2_CODFOR, '')) fornece, RTRIM(ISNULL(CT2_MANUAL, '')) manual,
                   CT2_VALOR valor
              FROM CT2010 WITH (NOLOCK)
             WHERE D_E_L_E_T_ <> '*' AND CT2_DATA BETWEEN @inicio AND @fim
               AND LEFT(RTRIM(CT2_DEBITO), 1) = '4'
               AND RTRIM(ISNULL(CT2_CCD, '')) <> ''
            UNION ALL
            SELECT LEFT(CT2_DATA, 6) ymes, CT2_DATA data, RTRIM(CT2_CCC) cc,
                   RTRIM(CT2_CREDIT) conta, RTRIM(ISNULL(CT2_DOC, '')) doc,
                   RTRIM(ISNULL(CT2_LOTE, '')) lote, RTRIM(ISNULL(CT2_HIST, '')) hist,
                   RTRIM(ISNULL(CT2_CODFOR, '')) fornece, RTRIM(ISNULL(CT2_MANUAL, '')) manual,
                   -CT2_VALOR valor
              FROM CT2010 WITH (NOLOCK)
             WHERE D_E_L_E_T_ <> '*' AND CT2_DATA BETWEEN @inicio AND @fim
               AND LEFT(RTRIM(CT2_CREDIT), 1) = '4'
               AND RTRIM(ISNULL(CT2_CCC, '')) <> ''
               -- Ponto 3 (controladoria): desconsiderar CREDITOS de PIS/COFINS, que
               -- reduziam a despesa (hist "CRED COFINS/PIS S/NF ..."). Sem eles a
               -- despesa fica BRUTA. So no lado credito (e onde o credito tributario cai).
               AND NOT (UPPER(RTRIM(ISNULL(CT2_HIST, ''))) LIKE '%CRED%COFINS%'
                     OR UPPER(RTRIM(ISNULL(CT2_HIST, ''))) LIKE '%CRED%PIS%')`, { inicio, fim });
          candidatos.forEach(([ymes]) => mesesFechadosOk.add(ymes));

          // Nome do fornecedor do lancamento (CT2_CODFOR), quando houver.
          const codsFor = [...new Set(razaoRows.map(r => trim(r.fornece)).filter(Boolean))];
          for (let i = 0; i < codsFor.length; i += 300) {
            const slice = codsFor.slice(i, i + 300);
            const p = {}; const inF = slice.map((c, k) => { p[`f${k}`] = c; return `@f${k}`; }).join(',');
            try {
              const rows = await Protheus.connectAndQuery(`
                SELECT RTRIM(A2_COD) cod, RTRIM(COALESCE(A2_NREDUZ, A2_NOME)) nome
                  FROM SA2010 WITH (NOLOCK)
                 WHERE D_E_L_E_T_ <> '*' AND A2_COD IN (${inF})`, p);
              rows.forEach(x => { if (!nomeForRazao.has(trim(x.cod))) nomeForRazao.set(trim(x.cod), trim(x.nome)); });
            } catch (e) { console.warn('dre-centro-custo: nome fornecedor do razao:', e.message); }
          }
        } catch (e) {
          console.warn('dre-centro-custo: razao indisponivel — visao segue por pedidos/titulos:', e.message);
          razaoRows = []; mesesFechadosOk.clear();
        }
      }
      // Mes contabilizado -> a fonte e o razao; pedidos/titulos desse mes sao
      // ignorados (senao o mesmo gasto entraria duas vezes).
      const mesFechado = (ymes) => mesesFechadosOk.has(trim(ymes));

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
          RTRIM(sc7.C7_FORNECE) AS fornece,
          RTRIM(sc7.C7_LOJA)    AS forneceLoja,
          sc7.C7_MOEDA          AS moeda,
          sc7.C7_TXMOEDA        AS taxa,
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
      let qtdMoedaEstrangeira = 0;   // linhas convertidas de moeda estrangeira p/ R$

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
        // Mes ja contabilizado: quem manda e o razao (bloco 3c).
        if (mesFechado(ymes)) continue;
        if (!ccPermitido(cc)) continue;
        if (contaOculta(conta)) continue;
        // Moeda do pedido: 1=Real, 2=Dolar (C7_MOEDA). C7_TOTAL vem na moeda do
        // documento -> converte p/ R$ pela taxa (C7_TXMOEDA) quando estrangeira,
        // pra o realizado do CC ficar todo em reais.
        const moeda = toN(r.moeda) || 1;
        const taxa = toN(r.taxa);
        const valorMoeda = toN(r.valor);   // valor na moeda do documento
        const valor = (moeda !== 1 && taxa > 0) ? valorMoeda * taxa : valorMoeda;  // R$
        if (moeda !== 1 && taxa > 0) qtdMoedaEstrangeira++;

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
          emissao: String(r.emissao || ''),
          fornece: trim(r.fornece),
          forneceLoja: trim(r.forneceLoja),
          moeda,
          taxa,
          valorMoeda,   // valor na moeda original (doc)
          valor         // já convertido p/ R$
        });

        if (!porMes.has(ymes)) porMes.set(ymes, { valor: 0, qtdItens: 0 });
        const agMes = porMes.get(ymes);
        agMes.valor += valor;
        agMes.qtdItens += 1;
      }

      // 3b) TÍTULOS DIRETOS do financeiro (FINA050 — fatura de cartão etc.):
      // gastos SEM pedido de compra (MONDAY/ADOBE/PIPEFY...) que não apareciam
      // na visão. Atribuição de CC em cascata:
      //   1. E2_CCD do título  2. rateio SEZ010 (EZ_CCUSTO)  3. de-para
      //   fornecedor->CC (tab_cc_fornecedor_depara)  4. balde "(SEM CC)".
      // Sem dupla contagem com pedidos: FINA050 é lançamento MANUAL — títulos de
      // NF de pedido nascem via MATA100. No drill: conta = natureza (NAT xxx),
      // item = fornecedor, documento = o título (flag direto:true).
      let qtdTitulosDiretos = 0, valorTitulosDiretos = 0, qtdTitulosSemCC = 0;
      const natUsadas = new Set();
      try {
        const se2 = await Protheus.connectAndQuery(`
          SELECT RTRIM(e2.E2_PREFIXO) prefixo, RTRIM(e2.E2_NUM) numero, RTRIM(e2.E2_PARCELA) parcela,
                 RTRIM(e2.E2_TIPO) tipo, RTRIM(e2.E2_FORNECE) fornece, RTRIM(e2.E2_LOJA) loja,
                 RTRIM(e2.E2_NATUREZ) natureza, RTRIM(ISNULL(e2.E2_CCD, '')) ccd,
                 RTRIM(ISNULL(e2.E2_CONTAD, '')) contaDebito,
                 e2.E2_EMISSAO emissao, e2.E2_VALOR valor,
                 RTRIM(COALESCE(sa2.A2_NREDUZ, sa2.A2_NOME, e2.E2_NOMFOR, '')) fornecedorNome
            FROM SE2010 e2 WITH (NOLOCK)
            LEFT JOIN SA2010 sa2 WITH (NOLOCK)
              ON sa2.A2_COD = e2.E2_FORNECE AND sa2.A2_LOJA = e2.E2_LOJA AND sa2.D_E_L_E_T_ <> '*'
           WHERE e2.D_E_L_E_T_ <> '*' AND e2.E2_FILIAL = '01'
             AND RTRIM(e2.E2_ORIGEM) = 'FINA050'
             AND RTRIM(e2.E2_TIPO) NOT IN ('PA', 'RA')
             AND e2.E2_VALOR > 0
             AND e2.E2_EMISSAO BETWEEN @inicio AND @fim`, { inicio, fim });

        // rateio SEZ dos títulos (batch por numero)
        const rateio = new Map();   // `${pref}|${num}|${parc}|${forn}|${loja}` -> [{cc, valor}]
        const numsTit = [...new Set(se2.map(r => trim(r.numero)))];
        for (let i = 0; i < numsTit.length; i += 300) {
          const slice = numsTit.slice(i, i + 300);
          const p = {}; const inN = slice.map((n, k) => { p[`n${k}`] = n; return `@n${k}`; }).join(',');
          try {
            const rows = await Protheus.connectAndQuery(`
              SELECT RTRIM(EZ_PREFIXO) prefixo, RTRIM(EZ_NUM) numero, RTRIM(EZ_PARCELA) parcela,
                     RTRIM(EZ_CLIFOR) fornece, RTRIM(EZ_LOJA) loja, RTRIM(EZ_CCUSTO) cc, EZ_VALOR valor
                FROM SEZ010 WITH (NOLOCK)
               WHERE D_E_L_E_T_ <> '*' AND RTRIM(EZ_CCUSTO) <> '' AND EZ_NUM IN (${inN})`, p);
            rows.forEach(r => {
              const k = [trim(r.prefixo), trim(r.numero), trim(r.parcela), trim(r.fornece), trim(r.loja)].join('|');
              if (!rateio.has(k)) rateio.set(k, []);
              rateio.get(k).push({ cc: trim(r.cc), valor: toN(r.valor) });
            });
          } catch (e) { console.warn('dre-centro-custo: SEZ batch err:', e.message); }
        }

        // de-para fornecedor -> CC (PG). Chave fornece+loja, fallback fornece+''.
        const depara = new Map();
        try {
          const dp = await Pg.connectAndQuery(`SELECT fornece, loja, cc FROM tab_cc_fornecedor_depara`, {});
          dp.forEach(d => depara.set(`${trim(d.fornece)}|${trim(d.loja)}`, trim(d.cc)));
        } catch (e) { console.warn('dre-centro-custo: de-para indisponível (migration 72?):', e.message); }

        // injeta na árvore — títulos SEM CC entram no grupo "(SEM CC)" (decisão
        // da controladoria em 09/07/2026: visualizar a massa não-atribuída pra
        // trabalhar o de-para depois). Obs.: inclui empréstimos/impostos — o
        // grupo pode ser grande; quando o de-para for populado, ele esvazia.
        const addTitulo = (cc, r, valor) => {
          const kCC = cc || '(SEM CC)';
          // O corte por CC fica aqui (e nao no laco) porque o rateio SEZ pode
          // dividir um mesmo titulo entre varios CCs — o gestor restrito leva so
          // a parcela do CC dele. Os cortes por mes/conta sao do titulo inteiro e
          // ficam no laco abaixo, pra nao inflar os contadores.
          if (!ccPermitido(kCC)) return;
          if (!cc) qtdTitulosSemCC++;
          const natureza = trim(r.natureza) || '(sem natureza)';
          const kConta = `NAT ${natureza}`;
          natUsadas.add(natureza);
          const kItem = trim(r.fornecedorNome) || trim(r.fornece) || '(sem fornecedor)';
          const ymes = String(r.emissao || '').slice(0, 6);
          const docId = `TIT ${trim(r.prefixo)}-${trim(r.numero)}`;

          if (!porCC.has(kCC)) porCC.set(kCC, { valor: 0, qtdItens: 0, pedidos: new Set(), porMes: new Map(), porConta: new Map() });
          const agCc = porCC.get(kCC);
          agCc.valor += valor; agCc.qtdItens += 1; agCc.pedidos.add(docId);
          agCc.porMes.set(ymes, toN(agCc.porMes.get(ymes)) + valor);

          if (!agCc.porConta.has(kConta)) agCc.porConta.set(kConta, { valor: 0, qtdItens: 0, porItem: new Map() });
          const aCt = agCc.porConta.get(kConta);
          aCt.valor += valor; aCt.qtdItens += 1;

          if (!aCt.porItem.has(kItem)) aCt.porItem.set(kItem, { descricao: 'Títulos diretos do financeiro (sem pedido)', valor: 0, qtdItens: 0, docs: [] });
          const aIt = aCt.porItem.get(kItem);
          aIt.valor += valor; aIt.qtdItens += 1;
          aIt.docs.push({
            pedido: `${trim(r.prefixo)}-${trim(r.numero)}`,
            itemPed: trim(r.parcela),
            emissao: String(r.emissao || ''),
            fornece: trim(r.fornece), forneceLoja: trim(r.loja),
            moeda: 1, taxa: 0, valorMoeda: valor, valor,
            direto: true
          });

          if (!porMes.has(ymes)) porMes.set(ymes, { valor: 0, qtdItens: 0 });
          const agMes = porMes.get(ymes);
          agMes.valor += valor; agMes.qtdItens += 1;
        };

        for (const r of se2) {
          // Mes contabilizado sai pelo razao (bloco 3c); conta oculta some pro
          // gestor restrito. Ambos valem pro titulo inteiro.
          if (mesFechado(String(r.emissao || '').slice(0, 6))) continue;
          if (contaOculta(r.contaDebito)) continue;
          qtdTitulosDiretos++;
          valorTitulosDiretos += toN(r.valor);
          const kTit = [trim(r.prefixo), trim(r.numero), trim(r.parcela), trim(r.fornece), trim(r.loja)].join('|');
          const ccd = trim(r.ccd);
          const rat = rateio.get(kTit);
          if (ccd) {
            addTitulo(ccd, r, toN(r.valor));
          } else if (rat && rat.length) {
            rat.forEach(x => addTitulo(x.cc, r, x.valor));   // rateio pode dividir em N CCs
          } else {
            const cc = depara.get(`${trim(r.fornece)}|${trim(r.loja)}`) || depara.get(`${trim(r.fornece)}|`) || '';
            addTitulo(cc, r, toN(r.valor));   // sem CC -> grupo "(SEM CC)"
          }
        }
      } catch (e) {
        console.warn('dre-centro-custo: bloco de títulos diretos falhou (segue só pedidos):', e.message);
      }

      // 3c) RAZAO (CT2010) — fonte dos meses JA CONTABILIZADOS.
      // Substitui pedidos+titulos nesses meses (eles foram pulados acima), entao o
      // valor do CC passa a ser exatamente o que a contabilidade fechou, incluindo
      // reclassificacao e ajuste manual. **Somente contas 4* (DESPESA)** com CC
      // preenchido — a classe 5 (CUSTOS: salarios/INSS/FGTS/materiais indiretos da
      // producao) foi EXCLUIDA por decisao da controladoria (21/08/2026): a analise
      // de despesa e so pela conta 4. O lado CREDITO entra negativo (estorno reduz a
      // despesa), mas os CREDITOS de PIS/COFINS foram excluidos na query (despesa
      // bruta). Arvore: CC -> conta contabil -> historico -> lancamento.
      let qtdLancRazao = 0, valorRazao = 0, valorAjusteManual = 0;
      for (const r of razaoRows) {
        const ymes = trim(r.ymes);
        if (!mesFechado(ymes)) continue;          // mes aberto ja saiu por pedidos
        const cc = trim(r.cc);
        const conta = trim(r.conta);
        if (!ccPermitido(cc)) continue;
        if (contaOculta(conta)) continue;

        const valor = toN(r.valor);
        const hist = trim(r.hist);
        const forn = trim(r.fornece);
        const manual = trim(r.manual) === '1';
        const kItem = nomeForRazao.get(forn) || hist || '(sem historico)';
        const docId = `RAZ ${trim(r.lote)}-${trim(r.doc)}`;

        qtdLancRazao++; valorRazao += valor;
        if (manual) valorAjusteManual += valor;

        if (!porCC.has(cc)) porCC.set(cc, { valor: 0, qtdItens: 0, pedidos: new Set(), porMes: new Map(), porConta: new Map() });
        const agCc = porCC.get(cc);
        agCc.valor += valor; agCc.qtdItens += 1; agCc.pedidos.add(docId);
        agCc.porMes.set(ymes, toN(agCc.porMes.get(ymes)) + valor);

        if (!agCc.porConta.has(conta)) agCc.porConta.set(conta, { valor: 0, qtdItens: 0, porItem: new Map() });
        const aCt = agCc.porConta.get(conta);
        aCt.valor += valor; aCt.qtdItens += 1;

        if (!aCt.porItem.has(kItem)) aCt.porItem.set(kItem, { descricao: 'Lançamento contábil (razão)', valor: 0, qtdItens: 0, docs: [] });
        const aIt = aCt.porItem.get(kItem);
        aIt.valor += valor; aIt.qtdItens += 1;
        aIt.docs.push({
          pedido: `${trim(r.lote)}-${trim(r.doc)}`,
          itemPed: '',
          emissao: String(r.data || ''),
          fornece: forn, forneceLoja: '',
          moeda: 1, taxa: 0, valorMoeda: valor, valor,
          razao: true,
          historico: hist,
          ajusteManual: manual   // lancado a mao pela contabilidade no fechamento
        });

        if (!porMes.has(ymes)) porMes.set(ymes, { valor: 0, qtdItens: 0 });
        const agMes = porMes.get(ymes);
        agMes.valor += valor; agMes.qtdItens += 1;
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
      descricoes.set('(SEM CC)', 'Títulos diretos sem CC — configure o de-para fornecedor→CC');

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
        // Chaves "NAT xxx" sao naturezas (titulos diretos), resolvidas mais abaixo
        // pela SED010 — nao sao conta contabil e nao vao pra CT1010.
        const arr = [...contasUnicas].filter(c => !/^NAT /.test(c));
        // Em lotes de 500: com o razao o numero de contas distintas cresce e o
        // MSSQL corta em 2100 parametros por comando.
        for (let i = 0; i < arr.length; i += 500) {
          const slice = arr.slice(i, i + 500);
          const p = {};
          const inClause = slice.map((c, k) => { p[`k${k}`] = c; return `@k${k}`; }).join(',');
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
      }

      // 4b.1) Descrições das NATUREZAS (SED010) — chaves "NAT xxx" dos títulos diretos
      if (natUsadas.size) {
        const arr = [...natUsadas].filter(n => n && n !== '(sem natureza)');
        for (let i = 0; i < arr.length; i += 400) {
          const slice = arr.slice(i, i + 400);
          const p = {}; const inN = slice.map((n, k) => { p[`n${k}`] = n; return `@n${k}`; }).join(',');
          try {
            const rows = await Protheus.connectAndQuery(`
              SELECT RTRIM(ED_CODIGO) nat, RTRIM(ED_DESCRIC) descricao
                FROM SED010 WITH (NOLOCK)
               WHERE D_E_L_E_T_ <> '*' AND RTRIM(ED_CODIGO) IN (${inN})`, p);
            rows.forEach(r => descContas.set(`NAT ${trim(r.nat)}`, `${trim(r.descricao)} (natureza — títulos diretos)`));
          } catch (e) { console.warn('dre-centro-custo: SED010 err:', e.message); }
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

      // 4d) NF de entrada (SD1) por pedido+item — a SC7 desta base NAO guarda a
      //     nota (sem C7_NOTA); o vinculo do documento fiscal e' via SD1
      //     (D1_PEDIDO+D1_ITEMPC -> D1_DOC/D1_SERIE). Pedido ainda nao faturado
      //     fica sem NF (compromisso). Usa numerosPC ja coletado acima.
      const nfPorPedidoItem = new Map(); // `${pedido}|${item}` -> { nota, serie }
      for (let i = 0; i < numerosPC.length; i += 500) {
        const slice = numerosPC.slice(i, i + 500);
        const inClause = slice.map((_, k) => `@d${k}`).join(',');
        const p = {};
        slice.forEach((n, k) => { p[`d${k}`] = n; });
        try {
          const rows = await Protheus.connectAndQuery(`
            SELECT RTRIM(D1_PEDIDO) pedido, RTRIM(D1_ITEMPC) item,
                   RTRIM(D1_DOC) doc, RTRIM(D1_SERIE) serie
              FROM SD1010 WITH (NOLOCK)
             WHERE D_E_L_E_T_ <> '*' AND D1_FILIAL = '01'
               AND RTRIM(D1_DOC) <> '' AND D1_PEDIDO IN (${inClause})`, p);
          rows.forEach(r => {
            const k = `${trim(r.pedido)}|${trim(r.item)}`;
            if (!nfPorPedidoItem.has(k)) nfPorPedidoItem.set(k, { nota: trim(r.doc), serie: trim(r.serie) });
          });
        } catch (e) {
          console.warn('dre-centro-custo: SD1010 err:', e.message);
        }
      }

      // 4e) Total e nº de itens do PEDIDO COMPLETO (todos os itens, todas as
      //     contas/CCs). No 4º nível cada linha e' UM item do pedido; sem esse
      //     contexto "PC 024541/0001 ... R$ 51" da a impressao de que o pedido/NF
      //     inteiro foi R$ 51. Aqui trazemos o total do pedido (em R$, convertendo
      //     moeda estrangeira) e a contagem de itens pra desfazer a confusao.
      const totalPorPedido = new Map(); // pedido -> { total (R$), qtItens }
      for (let i = 0; i < numerosPC.length; i += 500) {
        const slice = numerosPC.slice(i, i + 500);
        const inClause = slice.map((_, k) => `@t${k}`).join(',');
        const p = {};
        slice.forEach((n, k) => { p[`t${k}`] = n; });
        try {
          const rows = await Protheus.connectAndQuery(`
            SELECT RTRIM(C7_NUM) pedido, COUNT(*) qt,
                   SUM(CASE WHEN C7_MOEDA <> 1 AND C7_TXMOEDA > 0 THEN C7_TOTAL * C7_TXMOEDA ELSE C7_TOTAL END) total
              FROM SC7010 WITH (NOLOCK)
             WHERE D_E_L_E_T_ <> '*' AND C7_FILIAL = '01' AND C7_NUM IN (${inClause})
             GROUP BY C7_NUM`, p);
          rows.forEach(r => totalPorPedido.set(trim(r.pedido), { total: toN(r.total), qtItens: toN(r.qt) }));
        } catch (e) {
          console.warn('dre-centro-custo: total pedido err:', e.message);
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
                  .map(d => {
                    const nf = nfPorPedidoItem.get(`${d.pedido}|${d.itemPed}`);
                    const pt = d.direto ? null : totalPorPedido.get(d.pedido);
                    return {
                      pedido: d.pedido,
                      itemPed: d.itemPed,
                      nota: nf ? nf.nota : '',
                      serie: nf ? nf.serie : '',
                      emissao: d.emissao,
                      fornecedor: d.fornece,
                      fornecedorNome: nomeFornecedor.get(`${d.fornece}|${d.forneceLoja}`) || '',
                      moeda: d.moeda,
                      taxa: d.taxa,
                      valorMoeda: d.valorMoeda,
                      valor: d.valor,
                      direto: d.direto === true,   // título FINA050 (sem pedido)
                      razao: d.razao === true,          // lançamento do razão (mês contabilizado)
                      historico: d.historico || '',     // CT2_HIST (só razão)
                      ajusteManual: d.ajusteManual === true,   // CT2_MANUAL='1'
                      // Contexto do pedido completo (evita ler o valor do item como
                      // se fosse o valor do pedido/NF inteiro).
                      pedidoTotal: pt ? pt.total : null,
                      pedidoQtdItens: pt ? pt.qtItens : null,
                      pctItem: y.valor > 0 ? (d.valor / y.valor) * 100 : 0
                    };
                  })
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

      // 8) Totais agregados. Conta os documentos que REALMENTE entraram na arvore
      // (respeitando escopo do usuario, conta oculta e mes que saiu pelo razao) —
      // reprocessar o sc7 cru aqui inflaria o numero pro gestor restrito.
      const qtdPedidosUnicos = new Set();
      porCC.forEach(ag => ag.pedidos.forEach(d => qtdPedidosUnicos.add(d)));

      const orcadoAnualTotal = [...orcamentoPorCC.values()].reduce((s, o) => s + o.valorOrcado, 0);
      const orcadoYTDTotal   = orcadoAnualTotal * fatorYTD;

      // Fonte de cada mes do range — o frontend precisa dizer ao gestor se o numero
      // ja e o contabil fechado ou ainda e provisorio (pedidos/titulos).
      const fontePorMes = mesesNoRange.map(ymes => ({
        ymes,
        label: ymesLabel(ymes),
        fonte: mesFechado(ymes) ? 'RAZAO' : 'PROVISORIO',
        linhasRazao: toN(linhasRazao.get(ymes))
      }));

      return res.json({
        periodo: { inicio, fim, ano: anoFim, mesFim },
        geradoEm: new Date().toISOString(),
        // Escopo aplicado. restrito=true => o usuario so enxerga os CCs listados e
        // as contas ocultas nao entram em NENHUM total desta resposta. Devolve so a
        // CONTAGEM de contas ocultas — listar os codigos entregaria justamente o que
        // se quer esconder.
        escopo: {
          restrito: escopo.restrito,
          centrosCusto: escopo.restrito ? [...escopo.ccs] : null,
          qtdContasOcultas: escopo.restrito ? escopo.contasOcultas.size : 0
        },
        fontePorMes,
        totais: {
          valorTotal,
          qtdPedidos: qtdPedidosUnicos.size,
          qtdItens: [...porCC.values()].reduce((s, x) => s + x.qtdItens, 0),
          qtdCentros: porCC.size,
          qtdCentrosComOrcamento: orcamentoPorCC.size,
          qtdMoedaEstrangeira,   // linhas convertidas de moeda estrangeira p/ R$
          valorTotalEmReais: valorTotal,   // (alias explícito — tudo já em R$)
          // Títulos diretos do financeiro (FINA050, sem pedido) incluídos na visão
          qtdTitulosDiretos,
          valorTitulosDiretos,
          qtdTitulosSemCC,
          // Parcela vinda do razao (meses ja contabilizados) e quanto dela foi
          // ajuste manual da contabilidade no fechamento.
          qtdLancamentosRazao: qtdLancRazao,
          valorRazao,
          valorAjusteManual,
          mesesPeloRazao: fontePorMes.filter(f => f.fonte === 'RAZAO').length,
          mesesProvisorios: fontePorMes.filter(f => f.fonte === 'PROVISORIO').length,
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

// GET /gerencia/dre-contabil?inicio=YYYYMMDD&fim=YYYYMMDD
//
// DRE Contabil refinado — replica visualmente a planilha que a contadora
// apresenta pra diretoria ("Gnatus DRE e Razoes" em docs/). Fonte:
// CT2010 (lancamentos contabeis) + CT1010 (plano de contas).
//
// Diferenca do /gerencia/dre (modo conta):
//   - O DRE atual agrupa por LEFT(E2_CONTAD, 4) → ~10 grupos
//   - Este aqui agrupa pela CONTA COMPLETA (11 chars no Protheus, formato
//     N.N.NN.NNN.NNNN) → ~200 linhas, fiel a planilha
//   - Fonte: CT2010 (razao contabil) — inclui lancamentos de ajuste/
//     provisao mensal que a contadora faz e SE2/SF2 nao tem
//
// FONTE POR MES (28/08/2026) — mesma regra do DRE por Centro de Custo:
//   - Mes JA CONTABILIZADO (razao com muitas linhas) sai do RAZAO (CT2010).
//   - Mes EM ABERTO (razao ainda vazio — a contadora fecha ~1 mes depois) sai de
//     NOTAS (SF2/SD2/SE2, competencia por emissao) — a mesma fonte da aba
//     Gerencial —, encaixado nos MESMOS blocos contabeis. Assim o mes corrente
//     deixa de aparecer zerado. Medicao que embasou: em 28/08, jan-jul/26 tinham
//     6.000-9.700 linhas de razao DRE/mes; agosto tinha 40 (0 de receita). O
//     razao so recebe a receita perto do fechamento, entao as notas sao o
//     indicador antecedente correto pro mes aberto.
//   Cada mes devolve sua `fonte` (RAZAO | NOTAS) pro frontend deixar explicito, e
//   o resumo traz o total provisorio (parcela vinda de notas).
//
// Convencao de SINAL (espelhada da planilha):
//   Receita (3.x)        saldo CREDOR → valor NEGATIVO
//   Custo/Despesa (4.x)  saldo DEVEDOR → valor POSITIVO
//   Lucro liquido        somando tudo, fica NEGATIVO quando ha lucro
//   As notas seguem a MESMA convencao: receita entra negativa (-D2_TOTAL),
//   deducoes/CMV/despesas entram positivas.
//
// Roda 2x as queries (periodo + mesmo periodo ano anterior) pra YoY (AH%).
//
// Permissao 10001 (mesma do DRE Gerencial).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10001]);

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

// CFOPs de venda / devolucao — MESMA lista da aba Gerencial (gerencia.dre.js), pra
// o mes aberto casar com o que a diretoria ja ve la. 5907/6907 = faturamento
// futuro (receita reconhecida); 5924 = outras saidas. Excluidos 5934/5914
// (operacoes simbolicas, sem receita real).
const CFOPS_VENDA = ['5105','5106','5116','5117','5119','5405','5933',
                     '6105','6106','6107','6108','6109','6110','6116','6117',
                     '6119','6122','6123','6404','6933','5907','6907','5924'];
const CFOPS_DEVOLUCAO = ['1202','2202','1411','2411','1553','2553'];

// Abaixo disso o mes e considerado NAO contabilizado (razao ainda nao lancado) e a
// fonte passa a ser NOTAS. Mes fechado tem milhares de linhas de DRE no razao; mes
// aberto tem dezenas (agosto/26 tinha 40). O limiar so precisa separar essas ordens
// de grandeza — nao e um numero fino.
const MIN_LINHAS_RAZAO = 500;

// ============== Blocos totalizadores ==============
// Estrutura da planilha da contadora (validada com a aba "DRE 2026" do
// arquivo "Gnatus DRE e Razoes - Abril 2026.xlsx"). A ordem dos blocos
// aqui define a posicao no DRE.
//
// Cada bloco tem:
//   prefix:     array de prefixos do CT1_CONTA (sem pontos) que caem nesse bloco
//   excludePrefix: prefixos a EXCLUIR mesmo se o prefix bater (ex: 4.1.10.005
//                  bate "411" mas vai pra DEPRECIACOES, nao DESP_OP)
//   derivado:   array de outros bloco-ids cuja soma forma esse bloco
//   totalizador: true = soma de folhas com `prefix`
//
// IMPORTANTE: depreciacoes (4.1.10.005) e amortizacoes (4.1.10.006) tem bloco
// proprio (apos EBITDA, junto com financeiro) — nao entram em DESP_OP.
const BLOCOS = [
  { id: 'RECEITAS',          label: 'RECEITAS TOTAIS',                       prefix: ['311'],                                            totalizador: true },
  { id: 'DEDUCOES',          label: 'DEDUÇÕES DAS RECEITAS',                 prefix: ['312'],                                            totalizador: true },
  { id: 'RECEITA_LIQUIDA',   label: 'RECEITA LÍQUIDA',                       derivado: ['RECEITAS', 'DEDUCOES'] },
  { id: 'CUSTO',             label: 'CUSTO TOTAL',                           prefix: ['32'],                                             totalizador: true },
  { id: 'LUCRO_BRUTO',       label: 'LUCRO BRUTO (Margem de Contribuição)',  derivado: ['RECEITA_LIQUIDA', 'CUSTO'] },
  // '515' captura a folha de PRODUCAO (5.1.50.001). '51550002' = Materiais Indiretos
  // e CUSTO (absorvido no CMV pela contadora) — fica de fora das despesas p/ nao
  // duplicar com o CMV (mesma logica do exclude de materia-prima no /dre).
  { id: 'DESP_OP',           label: 'DESPESAS OPERACIONAIS',                 prefix: ['411', '412', '413', '515'],
                              excludePrefix: ['4110005', '4110006', '4140', '4150', '5150002'],                                          totalizador: true },
  { id: 'EBITDA',            label: 'RESULTADO OPERACIONAL (EBITDA)',        derivado: ['LUCRO_BRUTO', 'DESP_OP'] },
  { id: 'RES_FINANCEIRO',    label: 'RECEITAS/DESPESAS FINANCEIRAS',         prefix: ['4140', '4150'],                                    totalizador: true },
  { id: 'DEPRECIACAO',       label: 'DEPRECIAÇÕES / AMORTIZAÇÕES',           prefix: ['4110005', '4110006'],                              totalizador: true },
  { id: 'RES_ANTES_IR',      label: 'RESULTADO ANTES DO IRPJ E CSLL',        derivado: ['EBITDA', 'RES_FINANCEIRO', 'DEPRECIACAO'] },
  { id: 'IRPJ_CSLL',         label: 'IRPJ / CSL — Lucro Real',               prefix: ['416', '417'],                                      totalizador: true },
  { id: 'LUCRO_LIQUIDO',     label: 'RESULTADO DO PERÍODO',                  derivado: ['RES_ANTES_IR', 'IRPJ_CSLL'] }
];

function blocoDaConta(codigo) {
  const c = trim(codigo).replace(/\D/g, '');
  for (const b of BLOCOS) {
    if (!b.prefix) continue;
    const excl = b.excludePrefix || [];
    if (excl.some(p => c.startsWith(p))) continue;
    for (const p of b.prefix) {
      if (c.startsWith(p)) return b.id;
    }
  }
  return null;   // conta nao classificada — ignorada no DRE
}

// Formata codigo Protheus (sem pontos) pra apresentacao tipo "3.1.10.001.0001".
// Plano Gnatus: 1.1.NN.NNN.NNNN (1+1+2+3+4 = 11 chars).
function formatarCodigo(c) {
  const s = trim(c).replace(/\D/g, '');
  if (s.length !== 11) return s;
  return `${s.slice(0, 1)}.${s.slice(1, 2)}.${s.slice(2, 4)}.${s.slice(4, 7)}.${s.slice(7, 11)}`;
}

// YYYYMMDD - 1 ano
function minus1Year(ymd) {
  const s = trim(ymd).replace(/\D/g, '');
  if (s.length !== 8) return ymd;
  const y = +s.slice(0, 4) - 1, m = s.slice(4, 6), d = s.slice(6, 8);
  return `${y}${m}${d}`;
}

// Variacao horizontal: (atual - anterior) / |anterior|. anterior=0 → null
function ah(atual, anterior) {
  if (!anterior) return null;
  return (atual - anterior) / Math.abs(anterior);
}

// Lista de meses YYYYMM no range [inicio, fim].
function mesesDoRange(inicio, fim) {
  const out = [];
  let y = parseInt(inicio.slice(0, 4), 10), m = parseInt(inicio.slice(4, 6), 10);
  const yE = parseInt(fim.slice(0, 4), 10), mE = parseInt(fim.slice(4, 6), 10);
  while (y < yE || (y === yE && m <= mE)) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// '202608' -> 'ago/26'
const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const ymesLabel = (ymes) => {
  const s = String(ymes);
  if (s.length !== 6) return s;
  const m = parseInt(s.slice(4, 6), 10) - 1;
  return (MESES_PT[m] || '?') + '/' + s.slice(2, 4);
};

// Quantas linhas de DRE (contas 3/4/5) o razao ja tem por mes no range — vazio/baixo
// = mes ainda nao contabilizado (fonte NOTAS).
async function linhasRazaoPorMes(Protheus, inicio, fim) {
  const rows = await Protheus.connectAndQuery(`
    SELECT LEFT(CT2_DATA, 6) ymes, COUNT(*) linhas
      FROM CT2010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*' AND CT2_DATA BETWEEN @inicio AND @fim
       AND (LEFT(RTRIM(CT2_DEBITO), 1) IN ('3','4','5') OR LEFT(RTRIM(CT2_CREDIT), 1) IN ('3','4','5'))
     GROUP BY LEFT(CT2_DATA, 6)`, { inicio, fim });
  const m = new Map();
  rows.forEach(r => m.set(trim(r.ymes), N(r.linhas)));
  return m;
}

// ============== Carrega CT2010 (saldo por conta) — SO meses FECHADOS ==============
// Saldo de uma conta = SUM(CT2_VALOR onde DEBITO=conta) - SUM(onde CREDITO=conta)
// → positivo = devedora, negativo = credora. Separa a parcela MANUAL (CT2_MANUAL='1')
// — ajustes que a contabilidade posta a mao no fechamento (ex.: complemento de
// custo). Agrega por conta+mes e soma SO os meses ja contabilizados; o mes aberto
// sai por notas (senao o mesmo gasto entraria 2x).
async function carregarSaldosRazao(Protheus, inicio, fim, mesesFechados) {
  const sql = `
    SELECT conta, ymes, SUM(valor) saldo, SUM(CASE WHEN manual = '1' THEN valor ELSE 0 END) manual
      FROM (
        SELECT RTRIM(CT2_DEBITO) conta, LEFT(CT2_DATA, 6) ymes, RTRIM(CT2_MANUAL) manual, CT2_VALOR valor
          FROM CT2010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*'   -- consolida TODAS as filiais (01+02...), igual ao DRE da contadora
           AND CT2_DATA BETWEEN @inicio AND @fim
           AND LEFT(RTRIM(CT2_DEBITO), 1) IN ('3','4','5')
        UNION ALL
        SELECT RTRIM(CT2_CREDIT) conta, LEFT(CT2_DATA, 6) ymes, RTRIM(CT2_MANUAL) manual, -CT2_VALOR valor
          FROM CT2010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*'
           AND CT2_DATA BETWEEN @inicio AND @fim
           AND LEFT(RTRIM(CT2_CREDIT), 1) IN ('3','4','5')
      ) t
     GROUP BY conta, ymes`;
  const rows = await Protheus.connectAndQuery(sql, { inicio, fim });
  const map = new Map();   // conta -> { saldo, manual }
  rows.forEach(r => {
    if (!mesesFechados.has(trim(r.ymes))) return;   // mes aberto sai por notas
    const c = trim(r.conta);
    const cur = map.get(c) || { saldo: 0, manual: 0 };
    cur.saldo += N(r.saldo);
    cur.manual += N(r.manual);
    map.set(c, cur);
  });
  return map;
}

// ============== Carrega NOTAS (SF2/SD2/SE2) — SO meses ABERTOS ==============
// Provisorio pro mes que a contadora ainda nao fechou. Encaixa nos MESMOS blocos:
//   - Receita bruta por D2_CONTA (contas 311 reais) → NEGATIVO. Sem D2_CONTA → bucket
//   - Deducoes (ICMS/PIS/COFINS/IPI + devolucoes) → sinteticos no bloco DEDUCOES
//   - CMV (SUM D2_CUSTO1) → sintetico no bloco CUSTO
//   - Despesas por E2_CONTAD → blocoDaConta classifica (contas 1x/2x = Ativo/Passivo
//     retornam bloco nulo e sao DESCARTADAS de graca; so 4x entram). Exclui naturezas
//     201/202/203 (materia-prima) p/ nao duplicar com o CMV.
// Devolve { map, resumo } — resumo = parcela provisoria por componente (pro banner).
async function carregarNotasAbertas(Protheus, inicio, fim, mesesAbertos) {
  const vazio = { map: new Map(), resumo: { receitaBruta: 0, deducoes: 0, cmv: 0, despesas: 0, financeiro: 0, icms: 0, pis: 0, cofins: 0, ipi: 0, devolucoes: 0 } };
  if (!mesesAbertos.size) return vazio;

  // clausula IN dos meses abertos (sobre LEFT(emissao,6))
  const mArr = [...mesesAbertos];
  const mIn = mArr.map((_, i) => `@m${i}`).join(',');
  const mParams = {}; mArr.forEach((v, i) => { mParams[`m${i}`] = v; });

  const cv = CFOPS_VENDA.map((_, i) => `@cv${i}`).join(',');
  const cvParams = {}; CFOPS_VENDA.forEach((v, i) => { cvParams[`cv${i}`] = v; });
  const cd = CFOPS_DEVOLUCAO.map((_, i) => `@cd${i}`).join(',');
  const cdParams = {}; CFOPS_DEVOLUCAO.forEach((v, i) => { cdParams[`cd${i}`] = v; });

  const map = new Map();   // key -> { saldo, manual, bloco?, descricao?, provisorio }
  const addReal = (conta, valor) => {   // conta real (receita 311 / despesa 4x); blocoDaConta classifica
    const c = trim(conta);
    if (!c) return false;
    const cur = map.get(c) || { saldo: 0, manual: 0, provisorio: true };
    cur.saldo += valor; cur.provisorio = true;
    map.set(c, cur);
    return true;
  };
  const addSintetico = (key, bloco, descricao, valor) => {
    const cur = map.get(key) || { saldo: 0, manual: 0, bloco, descricao, provisorio: true };
    cur.saldo += valor;
    map.set(key, cur);
  };

  const resumo = { receitaBruta: 0, deducoes: 0, cmv: 0, despesas: 0, financeiro: 0, icms: 0, pis: 0, cofins: 0, ipi: 0, devolucoes: 0 };

  // 1) Receita + impostos + CMV (SD2 x SF2), agrupado por D2_CONTA
  const rec = await Protheus.connectAndQuery(`
    SELECT RTRIM(sd2.D2_CONTA) conta,
           SUM(sd2.D2_TOTAL) total, SUM(sd2.D2_VALICM) icms, SUM(sd2.D2_VALIPI) ipi,
           SUM(sd2.D2_VALIMP5) pis, SUM(sd2.D2_VALIMP6) cofins, SUM(sd2.D2_CUSTO1) cmv
      FROM SD2010 sd2 WITH (NOLOCK)
      INNER JOIN SF2010 sf2 WITH (NOLOCK)
        ON sf2.F2_FILIAL = sd2.D2_FILIAL AND sf2.F2_DOC = sd2.D2_DOC AND sf2.F2_SERIE = sd2.D2_SERIE
       AND sf2.F2_CLIENTE = sd2.D2_CLIENTE AND sf2.F2_LOJA = sd2.D2_LOJA AND sf2.D_E_L_E_T_ <> '*'
     WHERE sd2.D_E_L_E_T_ <> '*'
       AND sd2.D2_EMISSAO BETWEEN @inicio AND @fim AND sf2.F2_EMISSAO BETWEEN @inicio AND @fim
       AND LEFT(sd2.D2_EMISSAO, 6) IN (${mIn})
       AND RTRIM(sd2.D2_CF) IN (${cv})
     GROUP BY sd2.D2_CONTA`, { inicio, fim, ...mParams, ...cvParams });

  let receitaSemConta = 0;
  rec.forEach(r => {
    const total = N(r.total);
    resumo.receitaBruta += total;
    resumo.icms += N(r.icms); resumo.pis += N(r.pis); resumo.cofins += N(r.cofins); resumo.ipi += N(r.ipi);
    resumo.cmv += N(r.cmv);
    // Receita CREDORA → entra NEGATIVA. Conta real 311 quando houver; senao bucket.
    if (!addReal(r.conta, -total)) receitaSemConta += total;
  });
  if (Math.abs(receitaSemConta) > 0.005) {
    addSintetico('__REC_SEMCONTA', 'RECEITAS', 'Receita sem conta contábil (provisório — notas)', -receitaSemConta);
  }

  // 2) Devolucoes (SD1 x SF1)
  const dev = await Protheus.connectAndQuery(`
    SELECT SUM(sd1.D1_TOTAL) total
      FROM SD1010 sd1 WITH (NOLOCK)
      INNER JOIN SF1010 sf1 WITH (NOLOCK)
        ON sf1.F1_FILIAL = sd1.D1_FILIAL AND sf1.F1_DOC = sd1.D1_DOC AND sf1.F1_SERIE = sd1.D1_SERIE
       AND sf1.F1_FORNECE = sd1.D1_FORNECE AND sf1.F1_LOJA = sd1.D1_LOJA AND sf1.D_E_L_E_T_ <> '*'
     WHERE sd1.D_E_L_E_T_ <> '*'
       AND sd1.D1_EMISSAO BETWEEN @inicio AND @fim AND sf1.F1_EMISSAO BETWEEN @inicio AND @fim
       AND LEFT(sd1.D1_EMISSAO, 6) IN (${mIn})
       AND RTRIM(sd1.D1_CF) IN (${cd})`, { inicio, fim, ...mParams, ...cdParams });
  resumo.devolucoes = N(dev[0] && dev[0].total);

  // Deducoes → bloco DEDUCOES (positivo, reduz a receita liquida). 1 folha por componente.
  const deducoes = [
    ['__DED_ICMS', 'ICMS sobre vendas (provisório — notas)', resumo.icms],
    ['__DED_PIS', 'PIS sobre vendas (provisório — notas)', resumo.pis],
    ['__DED_COFINS', 'COFINS sobre vendas (provisório — notas)', resumo.cofins],
    ['__DED_IPI', 'IPI sobre vendas (provisório — notas)', resumo.ipi],
    ['__DED_DEV', 'Devoluções de vendas (provisório — notas)', resumo.devolucoes]
  ];
  deducoes.forEach(([k, desc, val]) => { if (Math.abs(val) > 0.005) addSintetico(k, 'DEDUCOES', desc, val); });
  resumo.deducoes = resumo.icms + resumo.pis + resumo.cofins + resumo.ipi + resumo.devolucoes;

  // CMV → bloco CUSTO (positivo)
  if (Math.abs(resumo.cmv) > 0.005) addSintetico('__CMV', 'CUSTO', 'CMV — custo das mercadorias vendidas (provisório — notas)', resumo.cmv);

  // 3) Despesas (SE2) por E2_CONTAD — blocoDaConta descarta 1x/2x; exclui MP 201/202/203
  const desp = await Protheus.connectAndQuery(`
    SELECT RTRIM(se2.E2_CONTAD) conta, SUM(se2.E2_VALOR) valor
      FROM SE2010 se2 WITH (NOLOCK)
     WHERE se2.D_E_L_E_T_ <> '*'
       AND se2.E2_EMISSAO BETWEEN @inicio AND @fim
       AND LEFT(se2.E2_EMISSAO, 6) IN (${mIn})
       AND RTRIM(se2.E2_CONTAD) <> ''
       AND LEFT(RTRIM(se2.E2_NATUREZ), 3) NOT IN ('201','202','203')
     GROUP BY se2.E2_CONTAD`, { inicio, fim, ...mParams });
  desp.forEach(r => {
    const bid = blocoDaConta(r.conta);
    if (!bid) return;                 // conta 1x/2x (Ativo/Passivo) ou nao-DRE
    addReal(r.conta, N(r.valor));     // despesa DEVEDORA → positiva
    if (bid === 'RES_FINANCEIRO') resumo.financeiro += N(r.valor);
    else resumo.despesas += N(r.valor);
  });

  return { map, resumo };
}

// Plano de contas CT1010 — descricao + flag analitica vs sintetica.
async function carregarPlanoContas(Protheus) {
  const rows = await Protheus.connectAndQuery(`
    SELECT RTRIM(CT1_CONTA) conta, RTRIM(CT1_DESC01) descricao,
           RTRIM(CT1_CLASSE) classe
      FROM CT1010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*'
       AND LEFT(RTRIM(CT1_CONTA), 1) IN ('3','4','5')`);
  const map = new Map();
  rows.forEach(r => map.set(trim(r.conta), {
    descricao: trim(r.descricao),
    analitica: trim(r.classe) === '2'   // 1=sintetica (totalizador), 2=analitica (folha)
  }));
  return map;
}

// Carrega o periodo inteiro (razao nos meses fechados + notas nos abertos) e devolve
// { saldos, fontePorMes, provisorio }. saldos = Map conta/chave -> { saldo, manual,
// bloco?, descricao?, provisorio? } pronto pro montarDre.
async function carregarPeriodo(Protheus, inicio, fim) {
  const meses = mesesDoRange(inicio, fim);
  const linhas = await linhasRazaoPorMes(Protheus, inicio, fim);
  const fechado = (ymes) => N(linhas.get(ymes)) >= MIN_LINHAS_RAZAO;
  const mesesFechados = new Set(meses.filter(fechado));
  const mesesAbertos = new Set(meses.filter(m => !fechado(m)));

  const [razao, notas] = await Promise.all([
    carregarSaldosRazao(Protheus, inicio, fim, mesesFechados),
    carregarNotasAbertas(Protheus, inicio, fim, mesesAbertos)
  ]);

  // Merge: razao primeiro, notas por cima (chaves reais somam; sinteticas ficam a parte)
  const saldos = new Map();
  razao.forEach((v, k) => saldos.set(k, { saldo: v.saldo, manual: v.manual }));
  notas.map.forEach((v, k) => {
    const cur = saldos.get(k) || { saldo: 0, manual: 0 };
    cur.saldo += v.saldo;
    if (v.bloco) { cur.bloco = v.bloco; cur.descricao = v.descricao; }
    if (v.provisorio) cur.provisorio = true;
    saldos.set(k, cur);
  });

  const fontePorMes = meses.map(ymes => ({
    ymes, label: ymesLabel(ymes),
    fonte: mesesFechados.has(ymes) ? 'RAZAO' : 'NOTAS',
    linhasRazao: N(linhas.get(ymes))
  }));

  return {
    saldos, fontePorMes,
    mesesAbertos: [...mesesAbertos],
    mesesFechados: [...mesesFechados],
    provisorio: notas.resumo
  };
}

// Monta o DRE a partir dos saldos (razao + notas ja mesclados) + plano de contas.
function montarDre(saldos, plano) {
  const folhasPorBloco = new Map();   // blocoId -> [{ codigo, codigoFmt, descricao, valor, ajusteManual, provisorio }]
  const totalPorBloco = new Map();
  const manualPorBloco = new Map();
  let ajusteManualTotal = 0;

  saldos.forEach((sal, key) => {
    const valor = sal.saldo, manual = sal.manual || 0;

    let bid, descricao, codigo, codigoFmt;
    if (sal.bloco) {
      // Entrada sintetica das notas (deducoes / CMV / receita sem conta): bloco explicito.
      bid = sal.bloco;
      descricao = sal.descricao || '(provisório)';
      codigo = ''; codigoFmt = '';
    } else {
      bid = blocoDaConta(key);
      if (!bid) return;
      const info = plano.get(key) || { descricao: '(sem descrição)', analitica: true };
      if (!info.analitica) return;    // ignora linhas sinteticas — quem soma e o totalizador
      descricao = info.descricao;
      codigo = key; codigoFmt = formatarCodigo(key);
    }
    if (Math.abs(valor) < 0.005) return;

    if (!folhasPorBloco.has(bid)) folhasPorBloco.set(bid, []);
    folhasPorBloco.get(bid).push({ codigo, codigoFmt, descricao, valor, ajusteManual: manual, provisorio: !!sal.provisorio });
    totalPorBloco.set(bid, (totalPorBloco.get(bid) || 0) + valor);
    manualPorBloco.set(bid, (manualPorBloco.get(bid) || 0) + manual);
    ajusteManualTotal += manual;
  });

  // Ordena folhas dentro de cada bloco: contas reais primeiro (por codigo), sinteticas depois
  folhasPorBloco.forEach(arr => arr.sort((a, b) => {
    if (!a.codigo && b.codigo) return 1;
    if (a.codigo && !b.codigo) return -1;
    return a.codigo.localeCompare(b.codigo);
  }));

  const derivados = {};
  BLOCOS.forEach(b => {
    if (b.derivado) {
      derivados[b.id] = b.derivado.reduce((acc, srcId) => acc + (totalPorBloco.get(srcId) || derivados[srcId] || 0), 0);
    }
  });

  const linhas = [];
  BLOCOS.forEach(b => {
    if (b.totalizador) {
      const folhas = folhasPorBloco.get(b.id) || [];
      folhas.forEach(f => linhas.push({
        tipo: 'folha', bloco: b.id, codigo: f.codigo, codigoFmt: f.codigoFmt,
        descricao: f.descricao, valor: f.valor, ajusteManual: f.ajusteManual || 0, provisorio: f.provisorio
      }));
      linhas.push({
        tipo: 'totalizador', bloco: b.id, codigo: '', codigoFmt: '',
        descricao: b.label, valor: totalPorBloco.get(b.id) || 0, ajusteManual: manualPorBloco.get(b.id) || 0
      });
    } else if (b.derivado) {
      linhas.push({
        tipo: 'derivado', bloco: b.id, codigo: '', codigoFmt: '',
        descricao: b.label, valor: derivados[b.id] || 0
      });
    }
  });

  return { linhas, totaisPorBloco: Object.fromEntries(totalPorBloco), derivados, ajusteManualTotal };
}

// ============== Endpoint ==============
module.exports = (app) => ({
  verb: 'get',
  route: '/dre-contabil',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const inicio = trim(req.query.inicio);
    const fim = trim(req.query.fim);
    if (!/^\d{8}$/.test(inicio) || !/^\d{8}$/.test(fim)) {
      return res.status(400).json({ message: 'Parametros inicio/fim devem ser YYYYMMDD.' });
    }
    if (inicio > fim) {
      return res.status(400).json({ message: 'inicio precisa ser <= fim.' });
    }

    const t0 = Date.now();
    const inicioAnt = minus1Year(inicio);
    const fimAnt = minus1Year(fim);

    try {
      const { Protheus } = app.services;

      const plano = await carregarPlanoContas(Protheus);

      const [periodoAtual, periodoAnterior] = await Promise.all([
        carregarPeriodo(Protheus, inicio, fim),
        carregarPeriodo(Protheus, inicioAnt, fimAnt)
      ]);

      const dreAtual = montarDre(periodoAtual.saldos, plano);
      const dreAnterior = montarDre(periodoAnterior.saldos, plano);

      // Cruzando: pra cada linha do periodo atual, busca o valor do anterior
      // pela mesma chave (codigo da folha OU bloco do totalizador/derivado).
      const valorAnteriorPorChave = new Map();
      dreAnterior.linhas.forEach(l => {
        const key = l.tipo === 'folha' ? (l.codigo || `__f_${l.descricao}`) : `__${l.bloco}`;
        valorAnteriorPorChave.set(key, l.valor);
      });

      const linhas = dreAtual.linhas.map(l => {
        const key = l.tipo === 'folha' ? (l.codigo || `__f_${l.descricao}`) : `__${l.bloco}`;
        const valorAnt = valorAnteriorPorChave.get(key) || 0;
        return { ...l, valorAnterior: valorAnt, ahPct: ah(l.valor, valorAnt) };
      });

      // Linhas que existem so no periodo anterior (ex.: conta encerrada agora)
      const chavesAtuais = new Set(dreAtual.linhas.filter(l => l.tipo === 'folha').map(l => l.codigo || `__f_${l.descricao}`));
      dreAnterior.linhas.forEach(l => {
        if (l.tipo !== 'folha') return;
        const key = l.codigo || `__f_${l.descricao}`;
        if (chavesAtuais.has(key)) return;
        const idx = linhas.findIndex(x => x.bloco === l.bloco && x.tipo === 'totalizador');
        const linhaExtra = { ...l, valor: 0, valorAnterior: l.valor, ahPct: -1 };
        if (idx > 0) linhas.splice(idx, 0, linhaExtra);
        else linhas.push(linhaExtra);
      });

      // Receita Bruta usada como base do AV%. AV% = valor / receita_bruta (em modulo).
      const receitaBrutaAtual = Math.abs(dreAtual.totaisPorBloco.RECEITAS || 0);
      linhas.forEach(l => { l.avPct = receitaBrutaAtual ? l.valor / receitaBrutaAtual : null; });

      const p = periodoAtual.provisorio;
      const temMesAberto = periodoAtual.mesesAbertos.length > 0;

      return res.json({
        periodo: { inicio, fim },
        periodoAnterior: { inicio: inicioAnt, fim: fimAnt },
        linhas,
        // Fonte de cada mes (RAZAO fechado | NOTAS em aberto) + resumo do provisorio,
        // pra tela deixar explicito pra diretoria que o mes corrente e estimativa.
        fontePorMes: periodoAtual.fontePorMes,
        mesesAbertos: periodoAtual.mesesAbertos.map(ymesLabel),
        temMesAberto,
        provisorio: temMesAberto ? {
          receitaBruta: p.receitaBruta,
          deducoes: p.deducoes,
          cmv: p.cmv,
          despesas: p.despesas,
          financeiro: p.financeiro,
          // lucro liquido provisorio aproximado do mes aberto (receita - deducoes - cmv - despesas - financeiro)
          total: p.receitaBruta - p.deducoes - p.cmv - p.despesas - p.financeiro
        } : null,
        resumo: {
          receitasTotais: dreAtual.totaisPorBloco.RECEITAS || 0,
          deducoes: dreAtual.totaisPorBloco.DEDUCOES || 0,
          receitaLiquida: dreAtual.derivados.RECEITA_LIQUIDA || 0,
          custoTotal: dreAtual.totaisPorBloco.CUSTO || 0,
          lucroBruto: dreAtual.derivados.LUCRO_BRUTO || 0,
          despesasOperacionais: dreAtual.totaisPorBloco.DESP_OP || 0,
          ebitda: dreAtual.derivados.EBITDA || 0,
          resultadoFinanceiro: dreAtual.totaisPorBloco.RES_FINANCEIRO || 0,
          irpjCsll: dreAtual.totaisPorBloco.IRPJ_CSLL || 0,
          lucroLiquido: dreAtual.derivados.LUCRO_LIQUIDO || 0,
          ajusteManual: dreAtual.ajusteManualTotal || 0   // total de lançamentos manuais (complemento de custo etc.)
        },
        resumoAnterior: {
          receitasTotais: dreAnterior.totaisPorBloco.RECEITAS || 0,
          ebitda: dreAnterior.derivados.EBITDA || 0,
          lucroLiquido: dreAnterior.derivados.LUCRO_LIQUIDO || 0
        },
        latenciaMs: Date.now() - t0,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('dre-contabil:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

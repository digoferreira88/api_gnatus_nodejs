// services/cockpitSopMontar.js — monta o objeto D do Cockpit S&OP a partir das
// leituras de services/cockpitSop.js e calcula a parte estatística.
//
// Fórmulas (docs/compras/gnatus_cockpit_sop_CONTEXTO.md, seção 5):
//   sazonalidade  média de cada mês nos anos fechados, EX-IVG, sobre a média geral
//   cenários      série dessazonalizada -> Conservador (persiste), Base (Holt 0,25/0,10),
//                 Otimista (média dos 3 maiores dos últimos 12) -> ressazonaliza
//   pedido->nota  Fat(M) = Σ peso[k]·Ped(M−k), k=0..3, por mínimos quadrados; MAPE 12m
//   mês aberto    projeção = acumulado até o dia ÷ fração média do mês naquele dia
//   ABC/XYZ       ABC por receita acumulada 12m (80/95); XYZ pelo coef. de variação
//   estoque       giro = demanda 12m ÷ 12; SS = 1,65 × desvio-padrão mensal
//
// Só mês FECHADO entra na base estatística. O mês corrente entra como parcial, com
// projeção — foi a opção escolhida em 22/09/2026.

const S = require('./cockpitSop');

const { trim, N, n2, ANOS, zeros, regiaoDe, NOMES_REGIAO, famOf, canalOf, ETAPA_POR_ESTATUS } = S;

const soma = (a) => a.reduce((x, y) => x + y, 0);
const media = (a) => (a.length ? soma(a) / a.length : 0);
const desvio = (a) => { if (a.length < 2) return 0; const m = media(a); return Math.sqrt(media(a.map(x => (x - m) ** 2))); };
const mediana = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
// Mediana de uma distribuição já agrupada: pares [valor, quantasVezes].
const medianaPonderada = (pares) => {
  const total = soma(pares.map(p => p[1]));
  if (!total) return 0;
  let acumulado = 0;
  for (const [valor, n] of [...pares].sort((a, b) => a[0] - b[0])) {
    acumulado += n;
    if (acumulado >= total / 2) return valor;
  }
  return 0;
};

// ---------------------------------------------------------------------------
// Séries
// ---------------------------------------------------------------------------
function serieVazia() {
  const o = {};
  ANOS.forEach(a => { o[a] = zeros(); });
  return o;
}

// rows tem ym ('AAAAMM') e os campos agregados; monta {ano: [12 meses]}
function montarSerie(rows, campo, filtro = () => true) {
  const out = serieVazia();
  rows.forEach(r => {
    if (!filtro(r)) return;
    const ym = trim(r.ym);
    const ano = ym.slice(0, 4), mes = Number(ym.slice(4, 6)) - 1;
    if (!out[ano] || mes < 0 || mes > 11) return;
    out[ano][mes] += N(r[campo]);
  });
  return out;
}

function montarSerieRegiao(rows, campo) {
  const out = {};
  NOMES_REGIAO.forEach(rg => { out[rg] = serieVazia(); });
  rows.forEach(r => {
    const rg = regiaoDe(r.uf);
    const ym = trim(r.ym), ano = ym.slice(0, 4), mes = Number(ym.slice(4, 6)) - 1;
    if (!out[rg][ano] || mes < 0 || mes > 11) return;
    out[rg][ano][mes] += N(r[campo]);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Motor estatístico
// ---------------------------------------------------------------------------

// Índice sazonal da entrada, ex-IVG, sobre os anos FECHADOS.
function indiceSazonal(serieExIvg, anosFechados) {
  const somaMes = zeros(), contaMes = zeros();
  anosFechados.forEach(ano => {
    (serieExIvg[ano] || zeros()).forEach((v, m) => { if (v > 0) { somaMes[m] += v; contaMes[m]++; } });
  });
  const medias = somaMes.map((s, m) => (contaMes[m] ? s / contaMes[m] : 0));
  const geral = media(medias.filter(v => v > 0));
  return medias.map(v => (geral > 0 && v > 0 ? v / geral : 1));
}

// Curva sazonal exibida na seção C: média de cada mês em todos os anos com dado.
function curvaSazonal(serie, serieExIvg, mesesFechados) {
  const v = zeros(), n = zeros(), comIVG = zeros();
  const somaEx = zeros(), somaCom = zeros();
  ANOS.forEach(ano => {
    (serieExIvg[ano] || zeros()).forEach((val, m) => {
      const fechado = ano < String(mesesFechados.ano) || (ano === String(mesesFechados.ano) && m < mesesFechados.mes);
      if (!fechado || val <= 0) return;
      somaEx[m] += val; somaCom[m] += N((serie[ano] || zeros())[m]); n[m]++;
    });
  });
  const mediaEx = somaEx.map((s, m) => (n[m] ? s / n[m] : 0));
  const geralEx = media(mediaEx.filter(x => x > 0));
  const mediaCom = somaCom.map((s, m) => (n[m] ? s / n[m] : 0));
  const geralCom = media(mediaCom.filter(x => x > 0));
  mediaEx.forEach((x, m) => { v[m] = geralEx > 0 ? x / geralEx : 1; comIVG[m] = geralCom > 0 ? mediaCom[m] / geralCom : 1; });
  return { v: v.map(x => n2(x)), n, comIVG: comIVG.map(x => n2(x)) };
}

// Pesos da defasagem pedido -> nota por mínimos quadrados (4 defasagens, sem
// intercepto), resolvido por eliminação de Gauss sobre a matriz normal.
function pesosDefasagem(pedFlat, fatFlat) {
  const K = 4;
  const linhas = [];
  for (let t = K - 1; t < fatFlat.length; t++) {
    const x = []; for (let k = 0; k < K; k++) x.push(pedFlat[t - k] || 0);
    if (x.some(v => v > 0) && fatFlat[t] > 0) linhas.push({ x, y: fatFlat[t] });
  }
  if (linhas.length < K + 2) return { pesos: [0.33, 0.21, 0.16, 0.27], mape: null };
  const A = Array.from({ length: K }, () => Array(K + 1).fill(0));
  linhas.forEach(({ x, y }) => {
    for (let i = 0; i < K; i++) {
      for (let j = 0; j < K; j++) A[i][j] += x[i] * x[j];
      A[i][K] += x[i] * y;
    }
  });
  for (let i = 0; i < K; i++) {
    let piv = i;
    for (let r = i + 1; r < K; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    if (Math.abs(A[piv][i]) < 1e-9) return { pesos: [0.33, 0.21, 0.16, 0.27], mape: null };
    [A[i], A[piv]] = [A[piv], A[i]];
    for (let r = 0; r < K; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c <= K; c++) A[r][c] -= f * A[i][c];
    }
  }
  const pesos = A.map((row, i) => (row[i] !== 0 ? row[K] / row[i] : 0));
  // MAPE de 1 passo nos últimos 12 meses com dado
  const ult = linhas.slice(-12);
  const erros = ult.map(({ x, y }) => {
    const prev = soma(x.map((v, k) => v * pesos[k]));
    return y > 0 ? Math.abs(prev - y) / y : 0;
  });
  return { pesos: pesos.map(p => Number(p.toFixed(4))), mape: erros.length ? Number((media(erros) * 100).toFixed(2)) : null };
}

// Holt linear (tendência amortecida pelos parâmetros do documento).
function holt(serie, alfa = 0.25, beta = 0.10) {
  const v = serie.filter(x => x > 0);
  if (v.length < 3) return { nivel: v.length ? v[v.length - 1] : 0, tend: 0 };
  let nivel = v[0], tend = v[1] - v[0];
  for (let i = 1; i < v.length; i++) {
    const anterior = nivel;
    nivel = alfa * v[i] + (1 - alfa) * (nivel + tend);
    tend = beta * (nivel - anterior) + (1 - beta) * tend;
  }
  return { nivel, tend };
}

// ---------------------------------------------------------------------------
// Montagem do D
// ---------------------------------------------------------------------------
async function montarD(app, { anoBase } = {}) {
  const { Protheus, Pg } = app.services;
  const t0 = Date.now();
  const hoje = S.hojeBrasilia();                       // 'AAAA-MM-DD'
  const ano = String(anoBase || Number(hoje.slice(0, 4)));
  const mesAtual = Number(hoje.slice(5, 7));           // 1..12
  const diaAtual = Number(hoje.slice(8, 10));
  const mesesFechados = mesAtual - 1;                  // no ano corrente
  const iniHist = `${ANOS[0]}0101`;
  const fimHist = `${ano}1231`;

  const [entrada, faturamento, fatSku, margemRows, idadeRows, leadRows, diarios, carteiraRows, estoqueRows, histRows, metaRows] = await Promise.all([
    S.lerEntrada(Protheus, iniHist, fimHist),
    S.lerFaturamento(Protheus, iniHist, fimHist),
    S.lerFaturamentoSku(Protheus, `${Number(ano) - 2}0101`, fimHist),
    S.lerMargem(Protheus, `${Number(ano) - 1}0101`, fimHist),
    S.lerIdadePedido(Protheus, `${Number(ano) - 1}0101`, fimHist),
    S.lerLeadTimePedido(Protheus, `${Number(ano) - 1}0101`, fimHist),
    S.lerDiarios(Protheus, `${Number(ano) - 2}0101`, fimHist),
    S.lerCarteira(Protheus),
    S.lerEstoque(Protheus),
    Pg.connectAndQuery(`SELECT ano_mes, SUM(valor_estoque)::float v FROM tab_estoque_snapshot_mensal GROUP BY ano_mes ORDER BY ano_mes`, {}),
    Pg.connectAndQuery(`SELECT ano, meta_faturamento::float meta FROM tab_sop_meta WHERE ano = @ano`, { ano: Number(ano) })
      .catch(() => [])   // tabela criada na migration 122; sem ela, o painel usa a meta padrão
  ]);

  // ---- séries
  const serie = {
    ped_v: montarSerie(entrada, 'v'), ped_q: montarSerie(entrada, 'q'), ped_n: montarSerie(entrada, 'n'),
    fat_v: montarSerie(faturamento, 'v'), fat_q: montarSerie(faturamento, 'q'), fat_n: montarSerie(faturamento, 'n')
  };
  const serieReg = {
    ped_v: montarSerieRegiao(entrada, 'v'), ped_q: montarSerieRegiao(entrada, 'q'),
    fat_v: montarSerieRegiao(faturamento, 'v'), fat_q: montarSerieRegiao(faturamento, 'q')
  };
  const seriePedLinhas = montarSerie(entrada, 'linhas');
  const ivg = montarSerie(entrada, 'v', r => N(r.ivg) === 1);
  const pedExIvg = {};
  ANOS.forEach(a => { pedExIvg[a] = serie.ped_v[a].map((v, m) => v - N((ivg[a] || zeros())[m])); });

  // ---- sazonalidade e modelo
  const anosFechados = ANOS.filter(a => Number(a) < Number(ano));
  const sazonal = indiceSazonal(pedExIvg, anosFechados);
  const sazCurva = curvaSazonal(serie.ped_v, pedExIvg, { ano: Number(ano), mes: mesesFechados });

  const flat = (s) => ANOS.flatMap(a => s[a].map((v, m) => ({ a, m, v })))
    .filter(x => Number(x.a) < Number(ano) || x.m < mesesFechados)
    .map(x => x.v);
  const modelo = pesosDefasagem(flat(serie.ped_v), flat(serie.fat_v));

  // ---- cenários (sobre a entrada dessazonalizada dos meses fechados)
  const pedFechados = ANOS.flatMap(a => serie.ped_v[a]
    .map((v, m) => ({ a, m, v }))
    .filter(x => (Number(x.a) < Number(ano) || x.m < mesesFechados) && x.v > 0));
  const dessaz = pedFechados.map(x => x.v / (sazonal[x.m] || 1));
  const emAberto = 12 - mesesFechados;                 // inclui o mês corrente
  const h = holt(dessaz);
  const ult12 = dessaz.slice(-12);
  const niveis = {
    Conservador: () => (dessaz.length ? dessaz[dessaz.length - 1] : 0),
    Base: (k) => h.nivel + h.tend * k,
    Otimista: () => media([...ult12].sort((a, b) => b - a).slice(0, 3))
  };
  const cenarios = {};
  const pedRealizado = soma(serie.ped_v[ano].slice(0, mesesFechados));
  const fatRealizado = soma(serie.fat_v[ano].slice(0, mesesFechados));
  const pedHistParaFat = [...flat(serie.ped_v)];
  for (const nome of ['Conservador', 'Base', 'Otimista']) {
    const pedMes = [];
    for (let k = 1; k <= emAberto; k++) {
      const mes = mesesFechados + k - 1;               // 0..11
      pedMes.push(Math.max(0, niveis[nome](k) * (sazonal[mes] || 1)));
    }
    // faturamento projetado pela defasagem, usando o histórico + a projeção de entrada
    const serieParaFat = [...pedHistParaFat, ...pedMes];
    const fatMes = [];
    for (let i = 0; i < emAberto; i++) {
      const t = pedHistParaFat.length + i;
      fatMes.push(soma(modelo.pesos.map((p, k) => p * (serieParaFat[t - k] || 0))));
    }
    const anoFat = fatRealizado + soma(fatMes);
    const precoMedio = soma(serie.fat_q[ano].slice(0, mesesFechados)) > 0
      ? fatRealizado / soma(serie.fat_q[ano].slice(0, mesesFechados)) : 0;
    cenarios[nome] = {
      pedMes: pedMes.map(v => n2(v)), fatMes: fatMes.map(v => n2(v)),
      pedAgoDez: n2(soma(pedMes)), fatAgoDez: n2(soma(fatMes)),
      anoPed: n2(pedRealizado + soma(pedMes)), anoFat: n2(anoFat),
      qtdAnoFat: Math.round(precoMedio > 0 ? anoFat / precoMedio : 0)
    };
  }

  // ---- referências e indicadores
  const anoAnt = String(Number(ano) - 1);
  const qtdFatAno = soma(serie.fat_q[ano].slice(0, mesesFechados));
  const ref = {
    ped2024: n2(soma(serie.ped_v['2024'] || zeros())), ped2025: n2(soma(serie.ped_v['2025'] || zeros())),
    fat2025: n2(soma(serie.fat_v['2025'] || zeros())), fatq2025: Math.round(soma(serie.fat_q['2025'] || zeros())),
    pedAgoDez25: n2(soma((serie.ped_v[anoAnt] || zeros()).slice(mesesFechados))),
    fatAgoDez25: n2(soma((serie.fat_v[anoAnt] || zeros()).slice(mesesFechados))),
    precoMedio26: qtdFatAno > 0 ? n2(fatRealizado / qtdFatAno) : 0
  };

  const margem = {};
  margemRows.forEach(r => { if (N(r.peso) > 0) margem[trim(r.ano)] = Number((N(r.ponderada) / N(r.peso)).toFixed(2)); });

  const trimestre = (a, t) => soma((serie.ped_v[a] || zeros()).slice(t * 3, t * 3 + 3));
  const cresc = (novo, velho) => (velho > 0 ? Number((((novo / velho) - 1) * 100).toFixed(1)) : 0);
  const momentum = { q1: cresc(trimestre(ano, 0), trimestre(anoAnt, 0)), q2: cresc(trimestre(ano, 1), trimestre(anoAnt, 1)) };

  // Idade do pedido faturado (lado da NOTA): p30 = % do valor faturado em até 30
  // dias; p60 = % do valor que levou MAIS de 60 dias. Só meses fechados.
  const idade = {};
  const porAnoIdade = {};
  idadeRows.forEach(r => {
    const a = trim(r.ano);
    if (a === ano && Number(trim(r.ym || '').slice(4, 6) || 0) > mesesFechados) return;
    (porAnoIdade[a] = porAnoIdade[a] || []).push({ d: Math.max(0, N(r.dias)), v: N(r.v), n: N(r.n) });
  });
  Object.entries(porAnoIdade).forEach(([a, linhas]) => {
    const total = soma(linhas.map(x => x.v));
    const fatia = (filtro) => (total > 0 ? Number((soma(linhas.filter(filtro).map(x => x.v)) / total * 100).toFixed(2)) : 0);
    const totalN = soma(linhas.map(x => x.n));
    idade[a] = {
      p30: fatia(x => x.d <= 30),
      p60: fatia(x => x.d > 60),
      mediana: medianaPonderada(linhas.map(x => [x.d, x.v])),
      media: total > 0 ? Number((soma(linhas.map(x => x.d * x.v)) / total).toFixed(2)) : 0,
      valor: n2(total)
    };
  });

  // Lead time (lado do PEDIDO): dias entre emitir e faturar o item.
  const leadtime = {};
  const porAnoLead = {};
  leadRows.forEach(r => { (porAnoLead[trim(r.ano)] = porAnoLead[trim(r.ano)] || []).push([Math.max(0, N(r.dias)), N(r.n)]); });
  Object.entries(porAnoLead).forEach(([a, pares]) => {
    const totalN = soma(pares.map(p => p[1]));
    leadtime[a] = {
      medio: totalN > 0 ? Number((soma(pares.map(p => p[0] * p[1])) / totalN).toFixed(2)) : 0,
      mediana: medianaPonderada(pares)
    };
  });

  const precos = {};
  ANOS.forEach(a => {
    const meses = a === ano ? mesesFechados : 12;
    const pv = soma((serie.ped_v[a] || zeros()).slice(0, meses)), pq = soma((serie.ped_q[a] || zeros()).slice(0, meses));
    const pn = soma((serie.ped_n[a] || zeros()).slice(0, meses));
    const pl = soma((seriePedLinhas[a] || zeros()).slice(0, meses));
    const fv = soma((serie.fat_v[a] || zeros()).slice(0, meses)), fq = soma((serie.fat_q[a] || zeros()).slice(0, meses));
    const fn = soma((serie.fat_n[a] || zeros()).slice(0, meses));
    precos[a] = {
      precoPed: pq > 0 ? n2(pv / pq) : 0, ticketPed: pn > 0 ? n2(pv / pn) : 0,
      precoFat: fq > 0 ? n2(fv / fq) : 0, ticketNF: fn > 0 ? n2(fv / fn) : 0,
      itensPorPed: pn > 0 ? Number((pl / pn).toFixed(2)) : 0
    };
  });

  // ---- mix: família, região e o cruzamento. Janela = jan até o último mês fechado,
  // nos dois anos (nunca ano cheio contra ano parcial).
  const naJanela = (ym, a) => trim(ym).slice(0, 4) === a && Number(trim(ym).slice(4, 6)) <= mesesFechados;
  const descPorSku = new Map(), famPorSku = new Map();
  fatSku.forEach(r => {
    const cod = trim(r.cod);
    if (!descPorSku.has(cod)) {
      descPorSku.set(cod, trim(r.descricao));
      famPorSku.set(cod, famOf(r.descricao, cod));
    }
  });

  const acumular = (mapa, chave, r, a) => {
    const o = mapa.get(chave) || { v25: 0, v26: 0, q25: 0, q26: 0 };
    if (a === anoAnt) { o.v25 += N(r.v); o.q25 += N(r.q); } else { o.v26 += N(r.v); o.q26 += N(r.q); }
    mapa.set(chave, o);
  };
  const mFam = new Map(), mReg = new Map(), mFamReg = new Map();
  fatSku.forEach(r => {
    const a = trim(r.ym).slice(0, 4);
    if ((a !== ano && a !== anoAnt) || !naJanela(r.ym, a)) return;
    const fam = famPorSku.get(trim(r.cod)) || 'Peças de Reposição';
    const rg = regiaoDe(r.uf);
    acumular(mFam, fam, r, a);
    acumular(mReg, rg, r, a);
    acumular(mFamReg, `${fam}|${rg}`, r, a);
  });
  const familiaFat = [...mFam.entries()].map(([fam, o]) => ({ fam, v25: n2(o.v25), v26: n2(o.v26), q25: Math.round(o.q25), q26: Math.round(o.q26) }))
    .sort((a, b) => b.v26 - a.v26);
  const regiao = NOMES_REGIAO.map(k => { const o = mReg.get(k) || { v25: 0, v26: 0, q25: 0, q26: 0 }; return { k, v25: n2(o.v25), v26: n2(o.v26), q25: Math.round(o.q25), q26: Math.round(o.q26) }; });
  const famRegiao = [...mFamReg.entries()].map(([k, o]) => {
    const [f, r] = k.split('|');
    return { f, r, v25: n2(o.v25), v26: n2(o.v26), q25: Math.round(o.q25), q26: Math.round(o.q26) };
  });

  // ---- ABC/XYZ sobre os últimos 12 meses fechados (TTM)
  const mesesTtm = [];
  for (let i = 1; i <= 12; i++) {
    const d = new Date(Date.UTC(Number(ano), mesesFechados - i, 1));
    mesesTtm.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const ttmSet = new Set(mesesTtm);
  const porSku = new Map();
  fatSku.forEach(r => {
    const cod = trim(r.cod), ym = trim(r.ym), a = ym.slice(0, 4);
    const o = porSku.get(cod) || { ttm: 0, meses: {}, v26: 0, v25: 0, q26: 0 };
    if (ttmSet.has(ym)) { o.ttm += N(r.v); o.meses[ym] = (o.meses[ym] || 0) + N(r.v); }
    if (a === ano && naJanela(ym, ano)) { o.v26 += N(r.v); o.q26 += N(r.q); }
    if (a === anoAnt && naJanela(ym, anoAnt)) { o.v25 += N(r.v); }
    porSku.set(cod, o);
  });
  const skusOrdenados = [...porSku.entries()].filter(([, o]) => o.ttm > 0).sort((a, b) => b[1].ttm - a[1].ttm);
  const totalTtm = soma(skusOrdenados.map(([, o]) => o.ttm));
  let acumuladoTtm = 0;
  const skuAll = [], skuClass = {}, skuCelula = {};
  skusOrdenados.forEach(([cod, o]) => {
    acumuladoTtm += o.ttm;
    const fracao = totalTtm > 0 ? acumuladoTtm / totalTtm : 1;
    const abc = fracao <= 0.8 ? 'A' : fracao <= 0.95 ? 'B' : 'C';
    const mensal = mesesTtm.map(m => o.meses[m] || 0);
    const m = media(mensal);
    const cv = m > 0 ? desvio(mensal) / m : 0;
    const xyz = cv <= 0.5 ? 'X' : cv <= 1.0 ? 'Y' : 'Z';
    const classe = abc + xyz;
    const linha = [cod, descPorSku.get(cod) || '', n2(o.ttm), n2(o.v26), n2(o.v25), Math.round(o.q26), Number(cv.toFixed(3)), classe, famPorSku.get(cod) || ''];
    skuAll.push(linha);
    skuClass[cod] = classe;
    (skuCelula[classe] = skuCelula[classe] || []).push({ cod, desc: linha[1], ttm: linha[2], v26: linha[3], v25: linha[4], q26: linha[5], cv: linha[6], cls: classe });
  });
  const matriz = [];
  ['A', 'B', 'C'].forEach(a => ['X', 'Y', 'Z'].forEach(x => {
    const lista = skuCelula[a + x] || [];
    matriz.push({ a, x, n: lista.length, v: n2(soma(lista.map(s => s.ttm))) });
  }));
  const resumo = ['A', 'B', 'C'].map(k => {
    const lista = skuAll.filter(s => s[7][0] === k);
    return { k, n: lista.length, v: n2(soma(lista.map(s => s[2]))) };
  });
  const abcxyz = { total: n2(totalTtm), skus: skuAll.length, matriz, resumo };
  const topSku = skuAll.slice(0, 10).map(s => ({ cod: s[0], desc: s[1], ttm: s[2], v26: s[3], v25: s[4], q26: s[5], cv: s[6], cls: s[7] }));

  // ---- carteira
  const hojeYmd = S.ymd(hoje);
  const inicioMes = `${hoje.slice(0, 4)}${hoje.slice(5, 7)}01`;
  const diasEntre = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8)) - Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8))) / 864e5);
  const bucketDe = (entregaYmd) => {
    if (!/^\d{8}$/.test(entregaYmd)) return 'a0';
    if (entregaYmd >= inicioMes) {
      const d = diasEntre(hojeYmd, entregaYmd);
      if (entregaYmd <= hojeYmd || d <= 0) return 'a0';                  // dentro do mês = no prazo
      const fimMes = `${hoje.slice(0, 4)}${hoje.slice(5, 7)}31`;
      if (entregaYmd <= fimMes) return 'a0';
      return d <= 30 ? 'f30' : d <= 60 ? 'f60' : d <= 90 ? 'f90' : 'f91p';
    }
    const atraso = diasEntre(entregaYmd, hojeYmd);
    return atraso > 180 ? 'a180' : atraso > 90 ? 'a91' : atraso > 60 ? 'a61' : 'a31';
  };

  const cart = { saldo: 0, resumoOficial: 0, qtdSaldo: 0, atraso: 0, atrasoMes: 0, futuro: 0, futuro30: 0 };
  const pedidosCart = new Set(), pedidosAtraso = new Set(), pedidosFuturo = new Set();
  const porStatus = new Map(), porCanal = new Map(), porBu = new Map(), porEvol = new Map(), agingMapa = new Map();
  const agingJanela = new Map();
  const mesRelativo = (entregaYmd) => {
    if (!/^\d{8}$/.test(entregaYmd)) return 'mesAtual';
    const ymEntrega = Number(entregaYmd.slice(0, 6));
    const ymHoje = Number(hoje.slice(0, 4) + hoje.slice(5, 7));
    const diff = (Math.floor(ymEntrega / 100) - Math.floor(ymHoje / 100)) * 12 + ((ymEntrega % 100) - (ymHoje % 100));
    if (diff < 0) return 'atrasada';
    if (diff === 0) return 'mesAtual';
    if (diff === 1) return 'mes1';
    if (diff === 2) return 'mes2';
    return 'mes3ouFut';
  };
  const skuIdx = new Map(), skuListCart = [];
  const detMapa = new Map(), evolIMapa = new Map();
  carteiraRows.forEach(r => {
    const valor = N(r.valor), saldoQtd = N(r.saldo);
    const entrega = trim(r.entrega);
    const etapa = ETAPA_POR_ESTATUS[N(r.estatusCod)] || 'Liberação do comercial';
    const canal = canalOf(r.canal);
    const bucket = bucketDe(entrega);
    const cod = trim(r.cod);

    cart.saldo += valor; cart.resumoOficial += N(r.valorIpi); cart.qtdSaldo += saldoQtd;
    pedidosCart.add(trim(r.pedido));
    if (entrega && entrega < inicioMes) { cart.atrasoMes += valor; pedidosAtraso.add(trim(r.pedido)); }
    if (entrega && entrega < hojeYmd) cart.atraso += valor;
    if (entrega && entrega >= inicioMes) { cart.futuro += valor; pedidosFuturo.add(trim(r.pedido)); if (bucket === 'f30' || bucket === 'a0') cart.futuro30 += valor; }

    const st = porStatus.get(etapa) || { v: 0, q: 0, peds: new Set() };
    st.v += valor; st.q += saldoQtd; st.peds.add(trim(r.pedido)); porStatus.set(etapa, st);
    porCanal.set(canal, (porCanal.get(canal) || 0) + valor);
    porBu.set(trim(r.canal), (porBu.get(trim(r.canal)) || 0) + N(r.valorIpi));
    agingMapa.set(bucket, (agingMapa.get(bucket) || 0) + valor);
    const janela = mesRelativo(entrega);
    agingJanela.set(janela, (agingJanela.get(janela) || 0) + valor);
    const chaveEvol = `${bucket}|${etapa}|${canal}`;
    porEvol.set(chaveEvol, (porEvol.get(chaveEvol) || 0) + valor);

    if (!skuIdx.has(cod)) { skuIdx.set(cod, skuListCart.length); skuListCart.push({ cod, desc: trim(r.descricao) }); }
    const iSku = skuIdx.get(cod);
    detMapa.set(`${iSku}|${canal}|${etapa}`, (detMapa.get(`${iSku}|${canal}|${etapa}`) || 0) + valor);
    evolIMapa.set(`${bucket}|${etapa}|${canal}|${iSku}`, (evolIMapa.get(`${bucket}|${etapa}|${canal}|${iSku}`) || 0) + valor);
  });
  const ORDEM_STATUS = ['Liberação do comercial', 'Liberação do planejamento', 'Liberação do financeiro',
    'Liberação de estoque', 'Aguardando faturamento', 'Formulação financeira'];
  const status = ORDEM_STATUS.filter(k => porStatus.has(k)).map(k => {
    const o = porStatus.get(k);
    return { k, v: n2(o.v), q: Math.round(o.q), p: o.peds.size };
  });
  const canais = [...porCanal.entries()].map(([k, v]) => ({ k, v: n2(v) })).sort((a, b) => b.v - a.v);
  const detCh = canais.map(c => c.k);
  const detSt = ORDEM_STATUS.filter(k => porStatus.has(k));
  const ORDEM_BUCKET = ['a180', 'a91', 'a61', 'a31', 'a0', 'f30', 'f60', 'f90', 'f91p'];
  const evol = [...porEvol.entries()].map(([k, v]) => { const [b, st, ch] = k.split('|'); return { b, st, ch, v: n2(v) }; });
  const evolI = [...evolIMapa.entries()].map(([k, v]) => {
    const [b, st, ch, iSku] = k.split('|');
    return [ORDEM_BUCKET.indexOf(b), detSt.indexOf(st), detCh.indexOf(ch), Number(iSku), n2(v)];
  });
  const det = [...detMapa.entries()].map(([k, v]) => {
    const [iSku, ch, st] = k.split('|');
    return [Number(iSku), detCh.indexOf(ch), detSt.indexOf(st), n2(v)];
  });
  const carteira = {
    ref: `${hoje.slice(8, 10)}/${hoje.slice(5, 7)}/${hoje.slice(0, 4)}`,
    saldo: n2(cart.saldo), resumoOficial: n2(Math.max(cart.resumoOficial, cart.saldo)),
    pedidos: pedidosCart.size, itens: carteiraRows.length, qtdSaldo: Math.round(cart.qtdSaldo),
    atraso: n2(cart.atraso), atrasoMes: n2(cart.atrasoMes), atrasoPed: pedidosAtraso.size,
    futuro: n2(cart.futuro), futuroPed: pedidosFuturo.size, futuro30: n2(cart.futuro30),
    status, canais, evol, evolI, det, detCh, detSt,
    skuList: skuListCart,
    // aging aqui é o resumo por janela de entrega (mesmos baldes da tela de Carteira);
    // a distribuição fina dos 9 buckets vai em evol/evolI.
    aging: {
      atrasada: n2(agingJanela.get('atrasada') || 0),
      mesAtual: n2(agingJanela.get('mesAtual') || 0),
      mes1: n2(agingJanela.get('mes1') || 0),
      mes2: n2(agingJanela.get('mes2') || 0),
      mes3ouFut: n2(agingJanela.get('mes3ouFut') || 0)
    },
    agingBuckets: Object.fromEntries(ORDEM_BUCKET.map(b => [b, n2(agingMapa.get(b) || 0)])),
    bu: [...porBu.entries()].map(([k, v]) => ({ k, v: n2(v) })).sort((a, b) => b.v - a.v)
  };

  // ---- estoque: faixas por giro e estoque de segurança (demanda dos 12 meses)
  // "Demanda recente" é mais estreita que a janela de 12 meses do giro: são os 3
  // últimos meses fechados (na base do setor, 778 dos 1.630 itens com giro).
  const recenteSet = new Set(mesesTtm.slice(0, 3));
  const demandaSku = new Map();
  fatSku.forEach(r => {
    const ym = trim(r.ym);
    if (!ttmSet.has(ym)) return;
    const cod = trim(r.cod);
    const o = demandaSku.get(cod) || { total: 0, recente: 0, meses: {} };
    o.total += N(r.q); o.meses[ym] = (o.meses[ym] || 0) + N(r.q);
    if (recenteSet.has(ym)) o.recente += N(r.q);
    demandaSku.set(cod, o);
  });
  const thr = {};
  demandaSku.forEach((o, cod) => {
    const mensal = mesesTtm.map(m => o.meses[m] || 0);
    thr[cod] = [n2(o.total / 12), n2(1.65 * desvio(mensal)), o.recente > 0 ? 1 : 0];
  });
  const saldoPorSku = new Map(), saldoPorSku0021 = new Map(), valorPorArmazem = new Map(), skusPorArmazem = new Map();
  let totalAll = 0, total0021 = 0;
  estoqueRows.forEach(r => {
    const cod = trim(r.cod), arm = trim(r.armazem), saldo = N(r.saldo), valor = N(r.valor);
    totalAll += valor;
    saldoPorSku.set(cod, (saldoPorSku.get(cod) || 0) + saldo);
    if (arm === '00' || arm === '21') { total0021 += valor; saldoPorSku0021.set(cod, (saldoPorSku0021.get(cod) || 0) + saldo); }
    valorPorArmazem.set(arm, (valorPorArmazem.get(arm) || 0) + valor);
    if (saldo > 0) { if (!skusPorArmazem.has(arm)) skusPorArmazem.set(arm, new Set()); skusPorArmazem.get(arm).add(cod); }
  });
  const valorUnit = new Map();
  {
    const acumulado = new Map();
    estoqueRows.forEach(r => {
      const cod = trim(r.cod), saldo = N(r.saldo);
      if (saldo <= 0) return;
      const o = acumulado.get(cod) || { v: 0, q: 0 };
      o.v += N(r.valor); o.q += saldo; acumulado.set(cod, o);
    });
    acumulado.forEach((o, cod) => { if (o.q > 0) valorUnit.set(cod, o.v / o.q); });
  }
  const codigosEmEstoque = new Set(estoqueRows.map(r => trim(r.cod)));
  const faixas = (saldos) => {
    const b = { Stockout: [0, 0], Seguranca: [0, 0], Giro: [0, 0], Excesso: [0, 0] };
    const sem = { semGiro: 0, over: 0 };
    // Stockout é "sem saldo em nenhum armazém" — só conta item que EXISTE na
    // posição de estoque e teve demanda recente; SKU que nunca foi estocado não é ruptura.
    const codigos = new Set([...saldos.keys(), ...Object.keys(thr).filter(c => codigosEmEstoque.has(c))]);
    codigos.forEach(cod => {
      const saldo = saldos.get(cod) || 0;
      const saldoGlobal = saldoPorSku.get(cod) || 0;
      const [giro, ss, temDemanda] = thr[cod] || [0, 0, 0];
      const unit = valorUnit.get(cod) || 0;
      const valor = saldo * unit;
      // Stockout = sem saldo em NENHUM armazém. Fica igual nas duas visões.
      if (saldoGlobal <= 0) { if (temDemanda) b.Stockout[0]++; return; }
      if (saldo <= 0) return;   // tem saldo em outro armazém, fora desta visão
      if (saldo <= ss) { b.Seguranca[0]++; b.Seguranca[1] += valor; return; }
      if (saldo <= ss + giro) { b.Giro[0]++; b.Giro[1] += valor; return; }
      b.Excesso[0]++; b.Excesso[1] += valor;
      if (!temDemanda) sem.semGiro += valor; else sem.over += valor;
    });
    Object.keys(b).forEach(k => { b[k] = [b[k][0], n2(b[k][1])]; });
    return { faixas: b, excesso: { semGiro: n2(sem.semGiro), over: n2(sem.over) } };
  };
  const fAll = faixas(saldoPorSku), f0021 = faixas(saldoPorSku0021);
  const trend = histRows.map(r => [`${trim(r.ano_mes).slice(0, 4)}-${trim(r.ano_mes).slice(4, 6)}`, n2(r.v)]);
  const mesAnterior = trend.length > 1 ? trend[trend.length - 2][1] : 0;
  const estoque = {
    ref: carteira.ref, totalAll: n2(totalAll), total0021: n2(total0021),
    momPct: mesAnterior > 0 ? Number((((totalAll / mesAnterior) - 1) * 100).toFixed(1)) : 0,
    prevVal: n2(mesAnterior),
    trend,
    wh: [...valorPorArmazem.entries()].map(([arm, v]) => [arm, n2(v), (skusPorArmazem.get(arm) || new Set()).size]).sort((a, b) => b[1] - a[1]),
    bandsAll: fAll.faixas, bands0021: f0021.faixas,
    excessoAll: fAll.excesso, excesso0021: f0021.excesso,
    thr,
    qualTrend: { months: trend.slice(-12).map(t => t[0]), all: fAll.faixas, '0021': f0021.faixas }
  };

  // ---- curvas diárias: fração do mês já realizada em cada dia + espelho do ano anterior
  const cumShare = {};
  const espelhoMes = { ped: { v: {}, q: {}, n: {} }, fat: { v: {}, q: {}, n: {} } };
  const montarCurvas = (rows, prefixo) => {
    const porMes = new Map();
    rows.forEach(r => {
      const ym = trim(r.ym), dia = Number(trim(r.dia));
      if (!ym || !dia) return;
      const o = porMes.get(ym) || { v: zeros().concat(zeros(), zeros()).slice(0, 31).map(() => 0), q: Array(31).fill(0), n: Array(31).fill(0) };
      o.v[dia - 1] += N(r.v); o.q[dia - 1] += N(r.q); o.n[dia - 1] += N(r.n);
      porMes.set(ym, o);
    });
    ['v', 'q', 'n'].forEach(metrica => {
      const acumuladas = [];
      porMes.forEach((o, ym) => {
        const fechado = ym < `${ano}${String(mesesFechados + 1).padStart(2, '0')}`;
        const total = soma(o[metrica]);
        if (!fechado || total <= 0) return;
        let ac = 0;
        acumuladas.push(o[metrica].map(v => { ac += v; return ac / total; }));
      });
      cumShare[`${prefixo}_${metrica}`] = Array.from({ length: 31 },
        (_, d) => Number(media(acumuladas.map(c => c[d] || 1)).toFixed(4)));
      // espelho do ano anterior, acumulado por dia
      porMes.forEach((o, ym) => {
        if (ym.slice(0, 4) !== anoAnt) return;
        const mes = Number(ym.slice(4, 6));
        let ac = 0;
        espelhoMes[prefixo === 'ped' ? 'ped' : 'fat'][metrica][mes] = o[metrica].map(v => { ac += v; return n2(ac); });
      });
    });
  };
  montarCurvas(diarios.ped, 'ped');
  montarCurvas(diarios.fat, 'fat');

  // ---- Demand Bias: compara a foto de hoje com as anteriores (erosão da entrada)
  const bias = await calcularBias(Pg, serie.ped_v, ano, mesesFechados, hoje);

  const META_PADRAO = 130000000;
  const meta = metaRows.length ? N(metaRows[0].meta) : META_PADRAO;

  const D = {
    serie, serieReg, ivg, sazonal, sazCurva, modelo, cenarios, ref,
    margem, momentum, idade, precos, leadtime,
    familiaFat, regiao, famRegiao,
    abcxyz, skuAll, skuCelula, topSku, skuClass,
    carteira, estoque,
    cumShare, espelhoMes,
    baseMaxDia: 31, bias,
    meta,
    fonte: { pedLinhas: soma(entrada.map(r => N(r.linhas))), fatLinhas: fatSku.length },
    liveDefault: {},
    _meta: {
      geradoEm: new Date().toISOString(), ms: Date.now() - t0,
      mesesFechados, mesAtual, diaAtual, ano,
      parcial: { mes: mesAtual, dia: diaAtual }
    }
  };
  return D;
}

// A entrada é revisada para baixo depois do fechamento. Guardamos a foto de cada
// geração e comparamos a mais nova com a primeira de cada mês fechado.
async function calcularBias(Pg, pedV, ano, mesesFechados, hoje) {
  const vazio = { pct: 0, n: 0, piorPct: 0, piorMes: null, ref: null, baseRef: null, impactoBase: 0 };
  try {
    for (let m = 1; m <= mesesFechados; m++) {
      const ym = `${ano}${String(m).padStart(2, '0')}`;
      await Pg.connectAndQuery(
        `INSERT INTO tab_sop_entrada_snapshot (ano_mes, ref_data, valor) VALUES (@ym, @ref::date, @v)
         ON CONFLICT (ano_mes, ref_data) DO UPDATE SET valor = EXCLUDED.valor`,
        { ym, ref: hoje, v: n2(pedV[ano][m - 1]) });
    }
    const rows = await Pg.connectAndQuery(`
      SELECT ano_mes, MIN(ref_data)::text primeira, MAX(ref_data)::text ultima,
             MIN(valor)::float menor, MAX(valor)::float maior, COUNT(*) fotos
        FROM tab_sop_entrada_snapshot GROUP BY ano_mes HAVING COUNT(*) > 1 ORDER BY ano_mes`, {});
    if (!rows.length) return { ...vazio, ref: hoje };
    const variacoes = [];
    for (const r of rows) {
      const par = await Pg.connectAndQuery(
        `SELECT valor::float v, ref_data::text d FROM tab_sop_entrada_snapshot
          WHERE ano_mes = @ym AND ref_data IN (@a::date, @b::date) ORDER BY ref_data`,
        { ym: trim(r.ano_mes), a: trim(r.primeira), b: trim(r.ultima) });
      if (par.length < 2 || N(par[0].v) <= 0) continue;
      variacoes.push({ ym: trim(r.ano_mes), pct: ((N(par[1].v) / N(par[0].v)) - 1) * 100, delta: N(par[1].v) - N(par[0].v) });
    }
    if (!variacoes.length) return { ...vazio, ref: hoje };
    const pior = variacoes.reduce((p, x) => (x.pct < p.pct ? x : p), variacoes[0]);
    return {
      pct: Number(media(variacoes.map(v => v.pct)).toFixed(2)),
      n: variacoes.length,
      piorPct: Number(pior.pct.toFixed(2)),
      piorMes: `${pior.ym.slice(4, 6)}/${pior.ym.slice(0, 4)}`,
      ref: hoje, baseRef: `${ano}-${String(mesesFechados).padStart(2, '0')}`,
      impactoBase: n2(soma(variacoes.map(v => v.delta)))
    };
  } catch (e) {
    console.warn('[cockpit-sop] bias indisponível:', e.message);
    return { ...vazio, ref: hoje };
  }
}

// A montagem leva ~3 s e lê 2023 até hoje; o painel é de leitura gerencial, então
// vale servir a mesma foto por alguns minutos. Salvar a meta limpa o cache.
const CACHE_MS = () => Math.max(1, Number(process.env.COCKPIT_SOP_TTL_MIN || 15)) * 60e3;
let cache = null;   // { em, D }
const limparCache = () => { cache = null; };

async function obterD(app, { semCache = false } = {}) {
  if (!semCache && cache && Date.now() - cache.em < CACHE_MS()) return cache.D;
  const D = await montarD(app);
  cache = { em: Date.now(), D };
  return D;
}

module.exports = { montarD, obterD, limparCache, montarSerie, indiceSazonal, pesosDefasagem, holt, soma, media, desvio, mediana };

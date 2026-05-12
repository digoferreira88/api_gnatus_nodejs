// Helpers puros pra calculo de KPIs de estoque. Sem efeitos colaterais — todos
// recebem dados ja agregados e devolvem numeros/objetos.
//
// Glossario:
//   giro anual         = (saidas anualizadas) / (estoque medio)
//   cobertura_dias     = 360 / giro
//   demanda_media      = soma de saidas / N meses da janela
//   desvio_padrao      = STDDEV populacional sobre as saidas mensais
//   consumo_lead_time  = demanda_media * (lead_time_dias / 30)
//   estoque_seguranca  = z * desvio_padrao * sqrt(lead_time_dias / 30)
//   estoque_ideal      = consumo_lead_time + estoque_seguranca
//   excesso            = max(0, qtd_atual - estoque_ideal)
//   ruptura            = qtd_atual == 0
//   risco_ruptura      = qtd_atual < estoque_seguranca

const N = (v) => Number(v || 0);

// Curva ABC sobre uma lista [{cod, valor, ...}]. Devolve a lista com `classe`
// adicionada (A/B/C) seguindo o corte 80/15/5 sobre o valor acumulado.
function classificarABC(itens, getValor = (i) => i.valor) {
  const ordenados = [...itens].sort((a, b) => getValor(b) - getValor(a));
  const total = ordenados.reduce((s, i) => s + N(getValor(i)), 0);
  if (total <= 0) return ordenados.map(i => ({ ...i, classe: 'C', percAcum: 100 }));

  let acum = 0;
  return ordenados.map(i => {
    acum += N(getValor(i));
    const percAcum = (acum / total) * 100;
    const classe = percAcum <= 80 ? 'A' : percAcum <= 95 ? 'B' : 'C';
    return { ...i, percAcum: Number(percAcum.toFixed(2)), classe };
  });
}

// Giro anual a partir de saidas (12 meses) e estoque medio do periodo.
function calcularGiroAnual(saidas12m, estoqueMedio) {
  const s = N(saidas12m);
  const e = N(estoqueMedio);
  if (e <= 0) return 0;
  return Number((s / e).toFixed(2));
}

function calcularCoberturaDias(giroAnual) {
  const g = N(giroAnual);
  if (g <= 0) return null;
  return Math.round(360 / g);
}

// Estatisticas da demanda (media + desvio padrao populacional)
function estatisticasDemanda(saidasMensais) {
  const arr = (saidasMensais || []).map(N);
  if (!arr.length) return { media: 0, desvioPadrao: 0, n: 0 };
  const media = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variancia = arr.reduce((s, v) => s + (v - media) ** 2, 0) / arr.length;
  return {
    media: Number(media.toFixed(4)),
    desvioPadrao: Number(Math.sqrt(variancia).toFixed(4)),
    n: arr.length
  };
}

// Calcula consumo durante o lead time (qtd) + estoque de seguranca (qtd) +
// estoque ideal (qtd). Tudo em unidades.
function calcularSegurancaEIdeal({ demandaMedia, desvioPadrao, leadTimeDias, z }) {
  const lt = N(leadTimeDias) / 30;  // mes
  const consumoLeadTime = N(demandaMedia) * lt;
  const seguranca = N(z) * N(desvioPadrao) * Math.sqrt(Math.max(lt, 0));
  const ideal = consumoLeadTime + seguranca;
  return {
    consumoLeadTime: Number(consumoLeadTime.toFixed(4)),
    estoqueSeguranca: Number(seguranca.toFixed(4)),
    estoqueIdeal: Number(ideal.toFixed(4))
  };
}

// Classifica criticidade do produto: ruptura, risco, ideal, excesso.
function classificarCriticidade({ qtdAtual, estoqueSeguranca, estoqueIdeal }) {
  const q = N(qtdAtual);
  if (q <= 0) return 'ruptura';
  if (q < N(estoqueSeguranca)) return 'risco';
  if (q > N(estoqueIdeal) * 1.1) return 'excesso';  // 10% de tolerancia
  return 'ideal';
}

// Tendencia simples — compara consumo medio com pedidos colocados/recebimentos.
//   ratio = pedidos / consumo. Se >1.1 -> aumento, <0.9 -> reducao, senao neutro.
function classificarTendencia(consumoMedio, pedidosColocados) {
  const c = N(consumoMedio);
  const p = N(pedidosColocados);
  if (c <= 0 && p <= 0) return { tendencia: 'neutro', ratio: 1 };
  if (c <= 0) return { tendencia: 'aumento', ratio: 999 };
  const ratio = p / c;
  const tendencia = ratio > 1.1 ? 'aumento' : ratio < 0.9 ? 'reducao' : 'neutro';
  return { tendencia, ratio: Number(ratio.toFixed(2)) };
}

// Projecao linear simples — usa regressao sobre os ultimos N pontos pra projetar
// proximos M periodos.
function projecaoLinear(serie, periodosFuturos = 3) {
  const arr = (serie || []).map(N);
  const n = arr.length;
  if (n < 2) return Array(periodosFuturos).fill(arr[arr.length - 1] || 0);

  const xs = arr.map((_, i) => i);
  const mediaX = xs.reduce((s, v) => s + v, 0) / n;
  const mediaY = arr.reduce((s, v) => s + v, 0) / n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mediaX) * (arr[i] - mediaY);
    den += (xs[i] - mediaX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = mediaY - slope * mediaX;

  return Array.from({ length: periodosFuturos }, (_, i) => {
    const x = n + i;
    return Math.max(0, Number((intercept + slope * x).toFixed(2)));
  });
}

// Util: lista os ultimos N anomes (formato 'YYYYMM') a partir do mes atual.
//   ultimosAnoMes(12) -> ['202506', '202505', ..., '202407']
function ultimosAnoMes(n) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

function anoMesCorrente() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function anoMesAnterior(anoMes) {
  const ano = Number(anoMes.slice(0, 4));
  const mes = Number(anoMes.slice(4, 6));
  const d = new Date(ano, mes - 1, 1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = {
  classificarABC,
  calcularGiroAnual,
  calcularCoberturaDias,
  estatisticasDemanda,
  calcularSegurancaEIdeal,
  classificarCriticidade,
  classificarTendencia,
  projecaoLinear,
  ultimosAnoMes,
  anoMesCorrente,
  anoMesAnterior
};

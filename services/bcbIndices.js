// services/bcbIndices.js
// Cliente das Series Temporais do Banco Central (API publica, gratuita).
//   Doc: https://www.bcb.gov.br/Estabilidadefinanceira/SGS
//   Endpoint: https://api.bcb.gov.br/dados/serie/bcdata.sgs.{codigo}/dados
//
// Indices usados pra reajuste de contratos:
//   IPCA (433) — Indice de Precos ao Consumidor Amplo, IBGE
//   INPC (188) — Indice Nacional de Precos ao Consumidor, IBGE
//   IGPM (189) — IGP-M, FGV (Indice Geral de Precos do Mercado)
//   IGPC (192) — IGP-DI, FGV
//   SELIC (4189) — Selic acumulada no mes
//
// Cache simples em memoria com TTL 12h — esses indices mudam 1x/mes.

const CODIGOS = {
  IPCA: 433,
  INPC: 188,
  IGPM: 189,
  IGPC: 192,
  SELIC: 4189
};

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map();  // key: indice|dataIni|dataFim -> { dados, ts }

function fmtDataBcb (d) {
  // BCB aceita formato DD/MM/AAAA
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// Busca a serie do indice entre 2 datas (inclusive)
async function buscarSerie (indice, dataIni, dataFim) {
  const key = `${indice}|${dataIni.toISOString().slice(0, 10)}|${dataFim.toISOString().slice(0, 10)}`;
  const c = cache.get(key);
  if (c && Date.now() - c.ts < CACHE_TTL_MS) return c.dados;

  const cod = CODIGOS[indice];
  if (!cod) throw new Error(`Indice nao suportado: ${indice}`);

  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${cod}/dados?formato=json&dataInicial=${fmtDataBcb(dataIni)}&dataFinal=${fmtDataBcb(dataFim)}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`BCB ${r.status}: ${await r.text().then(t => t.slice(0, 200))}`);
  const arr = await r.json();
  // arr = [{ data: "01/05/2025", valor: "0.26" }, ...] — uma entrada por mes
  const dados = arr.map(x => ({
    data: x.data,                                  // DD/MM/AAAA
    iso:  `${x.data.slice(6, 10)}-${x.data.slice(3, 5)}-${x.data.slice(0, 2)}`,
    valor: Number(x.valor)
  }));
  cache.set(key, { dados, ts: Date.now() });
  return dados;
}

// Calcula a variacao acumulada do indice nos N ultimos meses ate o mes-base.
// Retorna { percentual_acumulado, fator_multiplicador, meses_usados, indice, mes_base }
async function variacaoAcumulada (indice, mesesPeriodo = 12, dataReferencia = new Date()) {
  // BCB devolve indices ate o mes anterior fechado — pega-se 14 meses pra ter
  // folga e cortar exatamente os N ultimos com dados disponiveis.
  const fim = new Date(dataReferencia.getFullYear(), dataReferencia.getMonth(), 1);
  const ini = new Date(fim.getFullYear(), fim.getMonth() - (mesesPeriodo + 2), 1);
  const serie = await buscarSerie(indice, ini, fim);
  if (serie.length < mesesPeriodo) {
    throw new Error(`BCB retornou apenas ${serie.length} meses, esperado ao menos ${mesesPeriodo}.`);
  }
  // pega exatamente os N ultimos
  const ultimos = serie.slice(-mesesPeriodo);
  // var. % acumulada = produto((1 + v/100)) - 1
  let fator = 1;
  for (const m of ultimos) fator *= 1 + (m.valor / 100);
  return {
    indice,
    meses_usados: ultimos.length,
    periodo_inicio: ultimos[0].iso,
    periodo_fim:    ultimos[ultimos.length - 1].iso,
    percentual_acumulado: Number(((fator - 1) * 100).toFixed(4)),
    fator_multiplicador: Number(fator.toFixed(8)),
    serie_detalhada: ultimos
  };
}

// Aplica reajuste a um valor (ex: 1500.00 * (1 + 4.32%) = 1564.80)
function aplicarReajuste (valorAtual, percentual) {
  if (!Number.isFinite(valorAtual) || !Number.isFinite(percentual)) return null;
  return Number((valorAtual * (1 + percentual / 100)).toFixed(2));
}

module.exports = { buscarSerie, variacaoAcumulada, aplicarReajuste, CODIGOS };

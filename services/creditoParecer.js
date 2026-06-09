// services/creditoParecer.js — parecer textual de crédito com IA (Claude).
//
// Recebe os indicadores JÁ CALCULADOS e pede à API Claude um parecer objetivo.
// A IA descreve/interpreta os números fornecidos — NÃO inventa dados.
// BEST-EFFORT: se não houver ANTHROPIC_API_KEY ou a chamada falhar, devolve um
// parecer-template montado a partir dos próprios indicadores (nunca lança erro).

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

const pct = (v) => v == null ? '—' : `${Number(v).toFixed(1)}%`;
const dias = (v) => `${Math.round(Number(v) || 0)} dia(s)`;
const brl = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

// Parecer de fallback (sem IA) — determinístico, a partir dos indicadores.
function parecerTemplate(d) {
  const i = d.indicadores, st = d.status;
  const partes = [];
  partes.push(`Cliente ${d.cliente.nome} — score interno ${d.scoreInterno} (${d.classificacao.label}).`);
  if (i.semHistorico) partes.push('Sem histórico de títulos suficiente para análise interna; recomenda-se complementar com consulta externa (bureau).');
  else {
    partes.push(`Pontualidade de ${pct(i.pontualidadePct)}, inadimplência atual de ${pct(i.inadimplenciaPct)} e atraso médio de ${dias(i.mediaAtrasoPond)}.`);
    if (i.maiorAtraso.dias > 0) partes.push(`Maior atraso registrado: ${dias(i.maiorAtraso.dias)} (${brl(i.maiorAtraso.valor)}).`);
    if (i.tendencia.piora) partes.push(`Atenção: tendência de DETERIORAÇÃO — atraso subiu ${dias(i.tendencia.deltaAtrasoDias)} nos últimos 6 meses.`);
    if (i.utilizacaoPct != null && i.utilizacaoPct > 90) partes.push(`Utilização de limite elevada (${pct(i.utilizacaoPct)}).`);
  }
  if (d.bureau) {
    const b = d.bureau;
    if (b.protestos && b.protestos.ativo) partes.push(`Bureau (${b.fonte || 'externo'}): PROTESTO ATIVO${b.protestos.qtd ? ` (${b.protestos.qtd})` : ''}.`);
    if (b.restricoes && Number(b.restricoes.qtd) > 0) partes.push(`Bureau: ${b.restricoes.qtd} restrição(ões) financeira(s).`);
    if (b.score != null) partes.push(`Score externo do bureau: ${Math.round(b.score)}.`);
  }
  if (d.cliente.bloqueado) partes.push('Cliente BLOQUEADO no cadastro.');
  partes.push(`Recomendação: ${st === 'APROVAR' ? 'APROVAR' : st === 'REPROVAR' ? 'REPROVAR' : 'REVISÃO MANUAL'}.`);
  return partes.join(' ');
}

async function gerar(d) {
  const fallback = parecerTemplate(d);
  if (!API_KEY) return { texto: fallback, fonte: 'template' };

  const resumo = {
    cliente: d.cliente.nome, uf: d.cliente.uf, limite: d.cliente.limite, bloqueado: d.cliente.bloqueado,
    score_interno: d.scoreInterno, classificacao: d.classificacao.label, status_sugerido: d.status,
    indicadores: d.indicadores, bureau_externo: d.bureau || null
  };
  const prompt =
`Você é um analista de crédito sênior de uma indústria. Com base EXCLUSIVAMENTE nos indicadores abaixo (NÃO invente nenhum número; use apenas os fornecidos), escreva um parecer de crédito objetivo em português, com 3 a 5 frases, destacando: situação de pagamento, principais riscos, tendência e uma recomendação clara. Seja direto e profissional, sem listar os números crus em formato de tabela.

Indicadores (JSON):
${JSON.stringify(resumo, null, 1)}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, temperature: 0.3, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) { console.warn('creditoParecer: Claude', r.status); return { texto: fallback, fonte: 'template' }; }
    const j = await r.json();
    const texto = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return texto ? { texto, fonte: 'ia' } : { texto: fallback, fonte: 'template' };
  } catch (e) {
    clearTimeout(timer);
    console.warn('creditoParecer: falha IA —', e.message);
    return { texto: fallback, fonte: 'template' };
  }
}

module.exports = { gerar, parecerTemplate };

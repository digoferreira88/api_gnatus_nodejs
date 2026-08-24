// services/datafreteTms.js — client do Datafrete TMS Services (X-api-key).
// Host services.v1.datafreteapi.com. CONTRATO do GET /ocorrencias DESCOBERTO e
// VALIDADO em 21/08/2026 (não documentado no Postman público; formato confirmado
// por sondagem após dica do suporte):
//   GET /ocorrencias?dt_inicio_ocorrencia=Y-m-d H:i:s&dt_fim_ocorrencia=Y-m-d H:i:s[&pagina=N]
//     -> { codigo_retorno: 1, evento: { pagina_atual, qtd_pagina, qtd_registro,
//          lista_evento: [{ tp_doc:"NF", chave_doc(44), serie_doc, numero_doc,
//                           cod_evento, ds_evento, ds_observacao_evento,
//                           dt_evento, dt_importacao }] } }
//   ⚠️ é `dt_INICIO_ocorrencia` (não dt_ini) e a data EXIGE hora (H:i:s).
//   Eventos de ENTREGA: cod_evento "1" (Entrega Realizada Normalmente) e
//   "2" (Entrega Fora da Data Programada) — ambos = entregue.
//   POST /ocorrencias = fila de IMPORTAÇÃO (escrita) — NUNCA usar aqui.

const trim = (v) => String(v == null ? '' : v).trim();

const BASE = () => trim(process.env.DATAFRETE_SERVICES_URL || 'https://services.v1.datafreteapi.com').replace(/\/$/, '');
const KEY = () => trim(process.env.DATAFRETE_SERVICES_KEY);
const COD_ENTREGA = new Set(['1', '2']);

const disponivel = () => !!KEY();

const fmtDataHora = (d, fim = false) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${fim ? '23:59:59' : '00:00:00'}`;
};

async function get(path, params) {
  const qs = new URLSearchParams(params).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(`${BASE()}${path}?${qs}`, {
      headers: { 'X-api-key': KEY(), Accept: 'application/json' },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch { /* mantém texto cru */ }
    return { ok: r.ok, http: r.status, json, txt: txt.slice(0, 2000) };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, http: 0, json: null, txt: e.message };
  }
}

// Todas as ocorrências da janela [hoje-dias .. hoje], paginando até o fim.
// A API limita cada busca a 5 DIAS ("O intervalo da busca não deve ser maior
// que 5 dias!", medido 21/08) — janelas maiores são fatiadas em blocos de 5,
// então dá pra pedir até 30 dias (recuperação pós-parada) em ~6 consultas.
// Devolve { ok, http, eventos: [...], txt? }.
async function consultarOcorrencias({ dias = 3 } = {}) {
  const DIA = 864e5;
  const totalDias = Math.min(Math.max(1, dias), 30);
  const agora = new Date();
  const eventos = [];

  for (let offset = 0; offset < totalDias; offset += 5) {
    const fimSlice = new Date(agora.getTime() - offset * DIA);
    const iniSlice = new Date(agora.getTime() - Math.min(offset + 5, totalDias) * DIA + DIA);
    const base = {
      dt_inicio_ocorrencia: fmtDataHora(iniSlice, false),
      dt_fim_ocorrencia: fmtDataHora(fimSlice, true)
    };
    let pagina = 1, totalPaginas = 1;
    do {
      const r = await get('/ocorrencias', { ...base, pagina });
      if (!r.ok || !r.json?.evento) {
        return { ok: false, http: r.http, eventos: [], txt: r.txt };
      }
      (r.json.evento.lista_evento || []).forEach(e => eventos.push(e));
      totalPaginas = Number(r.json.evento.qtd_pagina || 1);
      pagina++;
    } while (pagina <= totalPaginas && pagina <= 40);   // trava de segurança
  }
  return { ok: true, http: 200, eventos };
}

// Reduz os eventos a entregas por NF: [{ numeroNf, serieNf, chaveNf, descricao,
// dtEvento, entregue }] — 1 linha por chave, entregue=true se QUALQUER evento da
// NF for cod 1/2 (a última ocorrência pode ser posterior à entrega).
function extrairEntregas(eventos) {
  const porChave = new Map();
  for (const e of (eventos || [])) {
    const chave = trim(e.chave_doc);
    const k = chave || `${trim(e.numero_doc)}|${trim(e.serie_doc)}`;
    if (!porChave.has(k)) {
      porChave.set(k, {
        numeroNf: trim(e.numero_doc), serieNf: trim(e.serie_doc), chaveNf: chave,
        descricao: '', dtEvento: '', entregue: false
      });
    }
    const reg = porChave.get(k);
    const entrega = COD_ENTREGA.has(trim(e.cod_evento));
    if (entrega && !reg.entregue) {
      reg.entregue = true;
      reg.descricao = `${trim(e.ds_evento)}${trim(e.ds_observacao_evento) ? ` — ${trim(e.ds_observacao_evento)}` : ''}`.slice(0, 300);
      reg.dtEvento = trim(e.dt_evento);
    } else if (!reg.entregue) {
      reg.descricao = `${trim(e.ds_evento)}${trim(e.ds_observacao_evento) ? ` — ${trim(e.ds_observacao_evento)}` : ''}`.slice(0, 300);
      reg.dtEvento = trim(e.dt_evento);
    }
  }
  return [...porChave.values()];
}

module.exports = { disponivel, consultarOcorrencias, extrairEntregas };

// services/datafreteTms.js — client do Datafrete TMS Services (X-api-key).
// Host services.v1.datafreteapi.com, sondado em 18/08/2026:
//   GET /conhecimento-transporte  OK (documentado)
//   GET /ocorrencias              EXISTE (não documentado) — params de faixa
//     descobertos: dt_ini_ocorrencia/dt_fim_ocorrencia (e o par _importacao).
//     ⚠️ O FORMATO do valor ainda é recusado ("Faixa de data ocorrência
//     invalida!") — aguardando resposta do suporte Datafrete. Por isso o
//     formato é configurável via env (DATAFRETE_OCO_FORMATO) — quando vier a
//     resposta, deve bastar ajustar o env, sem deploy.
//   POST /ocorrencias = fila de IMPORTAÇÃO (escrita) — NUNCA usar aqui.

const trim = (v) => String(v == null ? '' : v).trim();

const BASE = () => trim(process.env.DATAFRETE_SERVICES_URL || 'https://services.v1.datafreteapi.com').replace(/\/$/, '');
const KEY = () => trim(process.env.DATAFRETE_SERVICES_KEY);
// Formatos suportados: 'Y-m-d' | 'Y-m-d H:i:s' | 'd/m/Y' | 'd/m/Y H:i:s'
const FORMATO = () => trim(process.env.DATAFRETE_OCO_FORMATO) || 'Y-m-d';

const disponivel = () => !!KEY();

const fmtData = (d, fim = false) => {
  const p = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const dmy = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  const hora = fim ? '23:59:59' : '00:00:00';
  switch (FORMATO()) {
    case 'Y-m-d H:i:s': return `${ymd} ${hora}`;
    case 'd/m/Y':       return dmy;
    case 'd/m/Y H:i:s': return `${dmy} ${hora}`;
    default:            return ymd;
  }
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

// Ocorrências numa janela de dias [hoje-dias .. hoje].
async function consultarOcorrencias({ dias = 3 } = {}) {
  const fim = new Date();
  const ini = new Date(fim.getTime() - dias * 864e5);
  return get('/ocorrencias', {
    dt_ini_ocorrencia: fmtData(ini, false),
    dt_fim_ocorrencia: fmtData(fim, true)
  });
}

// Extrai entregas do payload de ocorrências SEM conhecer o shape exato:
// varre o JSON atrás de objetos que tenham identificador de NF (numero/chave) e
// marca como entregue quando algum campo textual contém "entreg" sem negação
// ("não entregue", "insucesso", "recusado", "devolvido" NÃO contam).
// Devolve [{ numeroNf, chaveNf, descricao, entregue }].
const NEGATIVOS = /n[aã]o\s+entreg|insucesso|recusad|devolvid|extravi/i;
function extrairEntregas(payload) {
  const achados = [];
  const visita = (obj) => {
    if (Array.isArray(obj)) { obj.forEach(visita); return; }
    if (!obj || typeof obj !== 'object') return;
    const chaves = Object.keys(obj);
    const kNum = chaves.find(k => /^(numero_nf|nr_nf|doc_numero|numero_doc|nf)$/i.test(k));
    const kChave = chaves.find(k => /^(chave_nf|chave_nfe|doc_chave|chave)$/i.test(k));
    if (kNum || kChave) {
      const textos = chaves
        .filter(k => typeof obj[k] === 'string')
        .map(k => obj[k]).join(' | ');
      achados.push({
        numeroNf: kNum ? trim(obj[kNum]) : '',
        chaveNf: kChave ? trim(obj[kChave]) : '',
        descricao: textos.slice(0, 400),
        entregue: /entreg/i.test(textos) && !NEGATIVOS.test(textos)
      });
    }
    chaves.forEach(k => visita(obj[k]));
  };
  visita(payload);
  return achados;
}

module.exports = { disponivel, consultarOcorrencias, extrairEntregas };

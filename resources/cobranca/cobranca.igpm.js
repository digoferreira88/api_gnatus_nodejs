// GET /cobranca/igpm — variação mensal do IGP-M/FGV, para o simulador de
// negociação corrigir os títulos vencidos (mesma regra da planilha "Cobrança de
// boletos – Gnatus", cláusula 1 do contrato).
//
// Fonte: Banco Central, SGS série 189 (IGP-M/FGV, variação % no mês) — os mesmos
// números que o time digitava à mão na aba IGP-M da planilha (conferido em
// 26/10/2026: dez/25 a set/26 idênticos).
//
// O BCB é irregular (medido 26/10: às vezes 30s na 1ª chamada, depois 0,08s; um
// 400 esporádico). Por isso o usuário NUNCA espera o BCB se já existe série:
//   - a série fica em arquivo (sobrevive a restart e é compartilhada entre os
//     workers do pm2) + memória;
//   - responde na hora com o que tem; se passou de 6h, atualiza em 2º plano;
//   - busca com novas tentativas; e já busca ao carregar o módulo (boot).
// Só espera o BCB quando não há série nenhuma (1ª vez na máquina).
//
// Perm 9001/9002/9003 (as mesmas do cliente 360° de cobrança).

const fs = require('fs');
const os = require('os');
const path = require('path');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002, 9003]);

const URL_BCB = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.189/dados?formato=json&dataInicial=01/01/2018';
const ARQUIVO = path.join(os.tmpdir(), 'intranet-igpm-bcb.json');
const TTL_MS = 6 * 3600e3;
const TIMEOUT_MS = 25000;
const TENTATIVAS = 3;

let cache = null;          // { serie, buscadoEm }
let ultimaFalha = null;    // mensagem da última atualização que falhou
let emAndamento = null;    // promise da busca em curso (evita buscas duplicadas)

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

async function buscarUmaVez() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(URL_BCB, { headers: { Accept: 'application/json', 'User-Agent': 'IntranetGnatus/1.0' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`BCB HTTP ${r.status}`);
    const j = await r.json();
    // [{ data: 'dd/mm/aaaa', valor: '0.41' }] -> [{ mes: 'aaaa-mm', variacao: 0.0041 }]
    const serie = (Array.isArray(j) ? j : []).map(p => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(p.data || ''));
      const v = Number(String(p.valor).replace(',', '.'));
      return m && Number.isFinite(v) ? { mes: `${m[3]}-${m[2]}`, variacao: v / 100 } : null;
    }).filter(Boolean);
    if (!serie.length) throw new Error('BCB: série vazia ou formato inesperado');
    return serie;
  } finally { clearTimeout(t); }
}

function atualizar() {
  if (emAndamento) return emAndamento;
  emAndamento = (async () => {
    let erro;
    for (let i = 1; i <= TENTATIVAS; i++) {
      try {
        const serie = await buscarUmaVez();
        cache = { serie, buscadoEm: Date.now() };
        ultimaFalha = null;
        try { fs.writeFileSync(ARQUIVO, JSON.stringify(cache)); } catch (e) { /* só perde a persistência */ }
        return cache;
      } catch (e) {
        erro = e;
        if (i < TENTATIVAS) await esperar(1500 * i);
      }
    }
    ultimaFalha = erro && erro.message;
    console.warn('cobranca/igpm: BCB não respondeu após', TENTATIVAS, 'tentativas —', ultimaFalha);
    throw erro;
  })().finally(() => { emAndamento = null; });
  return emAndamento;
}

// Boot: carrega a série do arquivo (se houver) e atualiza em 2º plano se preciso.
try {
  const d = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  if (d && Array.isArray(d.serie) && d.serie.length) cache = d;
} catch (e) { /* sem arquivo ainda */ }
setTimeout(() => {
  if (!cache || Date.now() - cache.buscadoEm > TTL_MS) atualizar().catch(() => {});
}, 3000).unref();

function payload(c) {
  const out = {
    fonte: 'Banco Central — SGS 189 (IGP-M/FGV, variação mensal)',
    serie: c.serie,
    ultimoMes: c.serie[c.serie.length - 1].mes,
    buscadoEm: new Date(c.buscadoEm).toISOString()
  };
  // Série com mais de 2 dias sem conseguir atualizar: avisa (pode faltar o mês novo)
  if (ultimaFalha && Date.now() - c.buscadoEm > 2 * 864e5) {
    out.aviso = `Banco Central sem resposta — usando o IGP-M obtido em ${new Date(c.buscadoEm).toLocaleDateString('pt-BR')}.`;
  }
  return out;
}

module.exports = (app) => ({
  verb: 'get',
  route: '/igpm',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    if (cache) {
      if (Date.now() - cache.buscadoEm > TTL_MS) atualizar().catch(() => {});   // 2º plano
      return res.json(payload(cache));
    }
    try {
      await atualizar();
      return res.json(payload(cache));
    } catch (err) {
      return res.status(503).json({ message: 'IGP-M indisponível no momento (Banco Central não respondeu).' });
    }
  }
});

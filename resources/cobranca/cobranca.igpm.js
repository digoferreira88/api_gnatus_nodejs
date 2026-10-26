// GET /cobranca/igpm — variação mensal do IGP-M/FGV, para o simulador de
// negociação corrigir os títulos vencidos (mesma regra da planilha "Cobrança de
// boletos – Gnatus", cláusula 1 do contrato).
//
// Fonte: Banco Central, SGS série 189 (IGP-M/FGV, variação % no mês) — os mesmos
// números que o time digitava à mão na aba IGP-M da planilha (conferido em
// 26/10/2026: dez/25 a set/26 idênticos). Cache em memória de 6h; se o BC falhar,
// devolve a última série boa (com aviso) em vez de deixar o simulador sem índice.
//
// Perm 9001/9002/9003 (as mesmas do cliente 360° de cobrança).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002, 9003]);

const URL_BCB = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.189/dados?formato=json&dataInicial=01/01/2018';
const TTL_MS = 6 * 3600e3;
let cache = null;   // { serie, buscadoEm }

async function buscarBcb() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(URL_BCB, { headers: { Accept: 'application/json', 'User-Agent': 'IntranetGnatus/1.0' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`BCB HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) throw new Error('BCB: série vazia');
    // [{ data: 'dd/mm/aaaa', valor: '0.41' }] -> [{ mes: 'aaaa-mm', variacao: 0.0041 }]
    const serie = j.map(p => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(p.data || ''));
      const v = Number(String(p.valor).replace(',', '.'));
      return m && Number.isFinite(v) ? { mes: `${m[3]}-${m[2]}`, variacao: v / 100 } : null;
    }).filter(Boolean);
    if (!serie.length) throw new Error('BCB: formato inesperado');
    return serie;
  } finally { clearTimeout(t); }
}

module.exports = (app) => ({
  verb: 'get',
  route: '/igpm',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const fresco = cache && (Date.now() - cache.buscadoEm < TTL_MS);
    if (!fresco) {
      try {
        cache = { serie: await buscarBcb(), buscadoEm: Date.now() };
      } catch (err) {
        console.warn('cobranca/igpm: falha ao buscar no BCB —', err.message);
        if (!cache) return res.status(503).json({ message: 'IGP-M indisponível no momento (Banco Central não respondeu).' });
        return res.json({ ...payload(cache), aviso: 'Banco Central não respondeu — usando a última série obtida.' });
      }
    }
    return res.json(payload(cache));
  }
});

function payload(c) {
  return {
    fonte: 'Banco Central — SGS 189 (IGP-M/FGV, variação mensal)',
    serie: c.serie,
    ultimoMes: c.serie[c.serie.length - 1].mes,
    buscadoEm: new Date(c.buscadoEm).toISOString()
  };
}

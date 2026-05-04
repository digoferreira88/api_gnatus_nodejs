// Helper que retorna lista de CFOPs (faturamento ou carteira) da tab_vendas_cfop.
// Cache em memoria por 10min pra nao bater no PG em toda chamada.

const cache = { faturamento: null, carteira: null, expiraEm: 0 };
const TTL_MS = 10 * 60 * 1000;

async function getCfops(Pg, uso) {
  if (cache[uso] && cache.expiraEm > Date.now()) return cache[uso];

  const rows = await Pg.connectAndQuery(
    `SELECT cfop FROM tab_vendas_cfop WHERE uso = @uso AND ativo = true`,
    { uso }
  );
  cache[uso] = rows.map(r => r.cfop);
  cache.expiraEm = Date.now() + TTL_MS;
  return cache[uso];
}

// Para usar dentro de query SQL: gera lista 'XXXX','XXXX'
function inLista(cfops) {
  return cfops.map(c => `'${c}'`).join(',');
}

module.exports = { getCfops, inLista };

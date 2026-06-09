// Adapter do bureau QUOD. Normaliza a resposta para o formato padrão do módulo.
//
// >>> A chamada HTTP e o MAPEAMENTO exato dependem da doc do produto contratado
//     (Score PJ / Concentre / Define / Cadastro Positivo). Configurar via .env:
//       QUOD_API_URL   = base da API (sandbox ou produção)
//       QUOD_API_KEY   = token/chave (ou QUOD_API_USER/QUOD_API_PASS p/ basic)
//     Ao receber a doc, preencher montarRequest() + normalizar().

const URL  = process.env.QUOD_API_URL;
const KEY  = process.env.QUOD_API_KEY;
const USER = process.env.QUOD_API_USER;
const PASS = process.env.QUOD_API_PASS;

function disponivel() { return !!(URL && (KEY || (USER && PASS))); }

// Mapeia o JSON cru do Quod -> formato NORMALIZADO usado pelo módulo de crédito.
// (preencher conforme a doc; o "scoreRaw" guarda o original para auditoria)
function normalizar(raw) {
  return {
    fonte: 'quod',
    score: null,             // <- score do Quod já NORMALIZADO para 0-1000 (preencher)
    scoreRaw: raw && raw.score != null ? raw.score : null,
    classificacao: null,
    protestos:  { ativo: false, qtd: 0, valor: 0, ultimo: null },
    restricoes: { qtd: 0, valor: 0, itens: [] },
    pendencias: { qtd: 0, valor: 0 },
    cadastro:   {},          // situacao, abertura, cnae, capital, qsa...
    resumo: ''
  };
}

async function consultar(cnpj) {
  if (!disponivel()) {
    const e = new Error('Quod não configurado — defina QUOD_API_URL e QUOD_API_KEY (ou USER/PASS) no .env e finalize o mapeamento da doc.');
    e.naoConfigurado = true; throw e;
  }
  const digits = String(cnpj || '').replace(/\D/g, '');
  // TODO(doc): montar a requisição conforme o produto Quod contratado.
  const auth = KEY ? { Authorization: `Bearer ${KEY}` }
                   : { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`${URL.replace(/\/$/, '')}/consulta?documento=${digits}`, {
      method: 'GET', headers: { 'Content-Type': 'application/json', ...auth }, signal: ctrl.signal
    });
    clearTimeout(timer);
    const raw = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`Quod HTTP ${r.status}`); e.httpStatus = r.status; e.raw = raw; throw e; }
    return { httpStatus: r.status, resultado: normalizar(raw) };
  } catch (e) { clearTimeout(timer); throw e; }
}

module.exports = { disponivel, consultar, normalizar };

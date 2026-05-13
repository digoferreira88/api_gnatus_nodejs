// Script de validacao do endpoint REST SolicCompra/incluir (WSRESTFUL custom Develsoft)
//
// Roda 10 cenarios contra o endpoint e imprime PASS/FAIL pra cada um.
// Uso: `node test-solic-compra-incluir.js [url] [user] [pass]`
//      default: http://protheus.gnatus.com.br:8081/rest/SolicCompra/incluir
//               admin:Gn@tu5
//
// Pre-requisito: Node 18+ (usa fetch nativo).

const URL_DEFAULT = 'http://protheus.gnatus.com.br:8081/rest/SolicCompra/incluir';
const url  = process.argv[2] || URL_DEFAULT;
const user = process.argv[3] || 'admin';
const pass = process.argv[4] || 'Gn@tu5';

const authValido = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const authInvalido = 'Basic ' + Buffer.from('wrong:credentials').toString('base64');

const itemValido = {
  produto: 'TESTE-ITEM-001',
  quantidade: 10,
  local: '01',
  centro_custo: 'CC_TESTE',
  observacao: 'Item de teste'
};

const bodyValido = {
  filial: '01',
  solicitante: 'INTRANET',
  data_emissao: '20260513',
  data_necessaria: '20260520',
  observacao: 'Teste de validacao do endpoint SolicCompra',
  itens: [itemValido]
};

const tests = [
  // Testes 01 e 02 — AccessControl do AppServer Protheus bloqueia antes do
  // metodo AdvPL rodar (igual no bordero), entao body do 401 vem generico.
  // So validamos status code.
  {
    nome: '01) Sem Authorization',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyValido),
    esperaStatus: 401
  },
  {
    nome: '02) Basic Auth errado',
    headers: { 'Content-Type': 'application/json', Authorization: authInvalido },
    body: JSON.stringify(bodyValido),
    esperaStatus: 401
  },
  {
    nome: '03) Body vazio',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: '',
    esperaStatus: 400, esperaCodigo: 'BODY_INVALIDO'
  },
  {
    nome: '04) JSON invalido',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: '{filial:"01",sem_aspas}',
    esperaStatus: 400, esperaCodigo: 'JSON_INVALIDO'
  },
  {
    nome: '05) Sem filial',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({ solicitante: 'INTRANET', itens: [itemValido] }),
    esperaStatus: 400, esperaCodigo: 'FILIAL_OBRIGATORIA'
  },
  {
    nome: '06) Sem solicitante',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({ filial: '01', itens: [itemValido] }),
    esperaStatus: 400, esperaCodigo: 'SOLICITANTE_OBRIGATORIO'
  },
  {
    nome: '07) itens array vazio',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({ filial: '01', solicitante: 'INTRANET', itens: [] }),
    esperaStatus: 400, esperaCodigo: 'SEM_ITENS'
  },
  {
    nome: '08) item sem produto',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({
      filial: '01', solicitante: 'INTRANET',
      itens: [{ quantidade: 1, local: '01', centro_custo: 'CC' }]
    }),
    esperaStatus: 400, esperaCodigo: 'PRODUTO_OBRIGATORIO'
  },
  {
    nome: '09) item com quantidade zero',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({
      filial: '01', solicitante: 'INTRANET',
      itens: [{ produto: 'X', quantidade: 0, local: '01', centro_custo: 'CC' }]
    }),
    esperaStatus: 400, esperaCodigo: 'QUANTIDADE_INVALIDA'
  },
  {
    nome: '10) Payload valido (produto fake — deve rejeitar com PRODUTO_NAO_ENCONTRADO)',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify(bodyValido),
    esperaStatus: 200,  // ok=true mas com qtd_rejeitados
    esperaOk: true
  }
];

(async () => {
  console.log(`Endpoint: ${url}`);
  console.log(`Auth: ${user}:${'*'.repeat(pass.length)}\n`);

  let nPass = 0, nFail = 0;
  for (const t of tests) {
    try {
      const r = await fetch(url, { method: 'POST', headers: t.headers, body: t.body });
      const txt = await r.text();
      let json = null;
      try { json = JSON.parse(txt); } catch {}

      const statusOk = r.status === t.esperaStatus;
      const codigoOk = t.esperaCodigo ? (json?.codigo_erro === t.esperaCodigo) : true;
      const okOk     = t.esperaOk    !== undefined ? (json?.ok === t.esperaOk) : true;

      const verdict = statusOk && codigoOk && okOk;
      const icon = verdict ? '✓ PASS' : '✗ FAIL';
      console.log(`${icon}  ${t.nome}`);
      console.log(`        HTTP ${r.status} (esperado ${t.esperaStatus})`);
      if (t.esperaCodigo) console.log(`        codigo: ${json?.codigo_erro || '(vazio)'} (esperado ${t.esperaCodigo})`);
      if (t.esperaOk !== undefined) console.log(`        ok: ${json?.ok} (esperado ${t.esperaOk})`);
      if (json?.mensagem) console.log(`        mensagem: ${String(json.mensagem).slice(0, 80)}`);
      if (json?.sc_numero) console.log(`        sc_numero: ${json.sc_numero}`);
      if (!verdict) console.log(`        body: ${txt.slice(0, 300)}`);
      console.log();

      if (verdict) nPass++; else nFail++;
    } catch (err) {
      console.log(`✗ FAIL  ${t.nome}`);
      console.log(`        erro de rede/conexao: ${err.message}\n`);
      nFail++;
    }
  }
  console.log(`────────────────────────────────`);
  console.log(`Resultado: ${nPass} PASS · ${nFail} FAIL · total ${tests.length}`);
  process.exit(nFail > 0 ? 1 : 0);
})();

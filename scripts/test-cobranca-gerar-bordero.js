// Script de validacao do endpoint REST Cobranca/gerar-bordero (stub Develsoft)
//
// Roda 10 cenarios contra o endpoint e imprime PASS/FAIL pra cada um.
// Uso: `node test-cobranca-gerar-bordero.js [url] [user] [pass]`
//      default: http://protheus.gnatus.com.br:8081/rest/Cobranca/gerar-bordero
//               admin:Gn@tu5 (mesmas credenciais do AprovaCompras)
//
// Pre-requisito: Node 18+ (usa fetch nativo). Rodar da rede que tem rota pro
// Protheus (PC interno ou VPS via NAT).

const URL_DEFAULT = 'http://protheus.gnatus.com.br:8081/rest/Cobranca/gerar-bordero';
const url  = process.argv[2] || URL_DEFAULT;
const user = process.argv[3] || 'admin';
const pass = process.argv[4] || 'Gn@tu5';

const authValido = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const authInvalido = 'Basic ' + Buffer.from('wrong:credentials').toString('base64');

const bodyValido = {
  filial: '01',
  banco: '341',
  operador: 'teste-intranet',
  observacao: 'Teste de validacao do endpoint',
  titulos: [
    { prefixo: 'NF1', numero: '062881', parcela: '01', tipo: 'NF', cliente: '162571', loja: '01' }
  ]
};

const tests = [
  {
    nome: '01) Sem Authorization',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyValido),
    esperaStatus: 401, esperaCodigo: 'NAO_AUTENTICADO'
  },
  {
    nome: '02) Basic Auth errado',
    headers: { 'Content-Type': 'application/json', Authorization: authInvalido },
    body: JSON.stringify(bodyValido),
    esperaStatus: 401, esperaCodigo: 'NAO_AUTENTICADO'
  },
  {
    nome: '03) Body vazio',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: '',
    esperaStatus: 400, esperaCodigo: 'BODY_INVALIDO'
  },
  {
    nome: '04) Body acima de 256KB',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({ ...bodyValido, observacao: 'x'.repeat(270000) }),
    esperaStatus: 413, esperaCodigo: 'BODY_GRANDE'
  },
  {
    nome: '05) JSON invalido',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: '{filial:"01",sem_aspas}',
    esperaStatus: 400, esperaCodigo: 'JSON_INVALIDO'
  },
  {
    nome: '06) Sem filial',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({ banco: '341', titulos: bodyValido.titulos }),
    esperaStatus: 400, esperaCodigo: 'FILIAL_OBRIGATORIA'
  },
  {
    nome: '07) Sem banco',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({ filial: '01', titulos: bodyValido.titulos }),
    esperaStatus: 400, esperaCodigo: 'BANCO_OBRIGATORIO'
  },
  {
    nome: '08) titulos array vazio',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({ filial: '01', banco: '341', titulos: [] }),
    esperaStatus: 400, esperaCodigo: 'SEM_TITULOS'
  },
  {
    nome: '09) titulos com 501 itens (acima de 500)',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({
      filial: '01', banco: '341',
      titulos: Array.from({ length: 501 }, (_, i) => ({
        prefixo: 'NF1', numero: String(i + 1).padStart(6, '0'),
        parcela: '01', tipo: 'NF', cliente: '162571', loja: '01'
      }))
    }),
    esperaStatus: 400, esperaCodigo: 'MUITOS_TITULOS'
  },
  {
    nome: '10) Payload valido (stub responde OK)',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify(bodyValido),
    esperaStatus: 200, esperaOk: true
  }
];

(async () => {
  console.log(`Endpoint: ${url}`);
  console.log(`Auth: ${user}:${'*'.repeat(pass.length)}\n`);

  // Contadores renomeados pra evitar colisao com a const `pass` (senha) do topo
  // do arquivo — declarar `let pass` aqui criava TDZ que sombreava a senha.
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
      if (!verdict) console.log(`        body: ${txt.slice(0, 200)}`);
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

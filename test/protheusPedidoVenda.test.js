// Testes do cliente HTTP do PedidoVenda/incluir (services/protheusPedidoVenda.js):
// URL, autenticação, repetição só no 503, timeout e corpo que não é JSON.
// Rodar:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const PV = require('../services/protheusPedidoVenda');

const ENV = { PROTHEUS_API_URL: 'http://h/rest/', PROTHEUS_API_USER: 'u', PROTHEUS_API_PASS: 'p' };
const resposta = (status, corpo) => ({ status, text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) });
function fetchFalso(respostas) {
  const chamadas = [];
  const fn = async (url, opts) => {
    chamadas.push({ url, opts });
    const r = respostas[Math.min(chamadas.length - 1, respostas.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.chamadas = chamadas;
  return fn;
}
const op = (fetch, env = ENV) => ({ fetch, env, esperaRetryMs: 0, timeoutMs: 1000 });

test('200 devolve o corpo e manda Basic auth no path padrão', async () => {
  const f = fetchFalso([resposta(200, { status: 'CRIADO', pedido: '098765' })]);
  const r = await PV.incluirPedido({ id_externo: 1 }, op(f));
  assert.equal(r.http, 200);
  assert.deepEqual(r.corpo, { status: 'CRIADO', pedido: '098765' });
  assert.equal(r.erro, null);
  assert.equal(r.tentativas, 1);
  assert.equal(f.chamadas[0].url, 'http://h/rest/PedidoVenda/incluir');
  assert.equal(f.chamadas[0].opts.method, 'POST');
  assert.equal(f.chamadas[0].opts.headers.Authorization, 'Basic ' + Buffer.from('u:p').toString('base64'));
  assert.deepEqual(JSON.parse(f.chamadas[0].opts.body), { id_externo: 1 });
});

test('path pode ser trocado por PROTHEUS_API_PATH_PEDIDO_VENDA', async () => {
  const f = fetchFalso([resposta(200, {})]);
  await PV.incluirPedido({}, op(f, { ...ENV, PROTHEUS_API_PATH_PEDIDO_VENDA: '/zPedVenda/incluir' }));
  assert.equal(f.chamadas[0].url, 'http://h/rest/zPedVenda/incluir');
});

test('503 repete uma vez e devolve a segunda resposta', async () => {
  const f = fetchFalso([resposta(503, { message: 'sem licença' }), resposta(200, { status: 'CRIADO', pedido: '1' })]);
  const r = await PV.incluirPedido({}, op(f));
  assert.equal(f.chamadas.length, 2);
  assert.equal(r.tentativas, 2);
  assert.equal(r.http, 200);
});

test('503 duas vezes devolve 503 com tentativas 2', async () => {
  const f = fetchFalso([resposta(503, 'License Server'), resposta(503, 'License Server')]);
  const r = await PV.incluirPedido({}, op(f));
  assert.equal(f.chamadas.length, 2);
  assert.equal(r.http, 503);
  assert.equal(r.tentativas, 2);
});

test('500 não repete', async () => {
  const f = fetchFalso([resposta(500, { message: 'erro' }), resposta(200, {})]);
  const r = await PV.incluirPedido({}, op(f));
  assert.equal(f.chamadas.length, 1);
  assert.equal(r.http, 500);
});

test('timeout devolve erro TIMEOUT sem repetir', async () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const f = fetchFalso([abort, resposta(200, {})]);
  const r = await PV.incluirPedido({}, op(f));
  assert.equal(f.chamadas.length, 1);
  assert.equal(r.erro, 'TIMEOUT');
  assert.equal(r.corpo, null);
  assert.equal(r.tentativas, 1);
});

test('falha de rede devolve erro REDE sem repetir', async () => {
  const f = fetchFalso([new Error('ECONNREFUSED'), resposta(200, {})]);
  const r = await PV.incluirPedido({}, op(f));
  assert.equal(f.chamadas.length, 1);
  assert.equal(r.erro, 'REDE');
});

test('timeout de verdade aborta a chamada', async () => {
  const lento = async (url, opts) => new Promise((_, rej) => {
    opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const r = await PV.incluirPedido({}, { fetch: lento, env: ENV, esperaRetryMs: 0, timeoutMs: 30 });
  assert.equal(r.erro, 'TIMEOUT');
});

test('corpo que não é JSON vira null', async () => {
  const f = fetchFalso([resposta(500, '<html>erro</html>')]);
  const r = await PV.incluirPedido({}, op(f));
  assert.equal(r.http, 500);
  assert.equal(r.corpo, null);
  assert.equal(r.erro, null);
});

test('sem PROTHEUS_API_URL não chama o fetch', async () => {
  const f = fetchFalso([resposta(200, {})]);
  const r = await PV.incluirPedido({}, op(f, { PROTHEUS_API_USER: 'u', PROTHEUS_API_PASS: 'p' }));
  assert.equal(r.erro, 'CONFIG');
  assert.equal(r.tentativas, 0);
  assert.equal(f.chamadas.length, 0);
});

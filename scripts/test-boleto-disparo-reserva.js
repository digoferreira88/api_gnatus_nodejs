// Teste da RESERVA no disparo de boleto (anti-duplicidade), com Postgres,
// Protheus, e-mail e WhatsApp simulados. Uso: node scripts/test-boleto-disparo-reserva.js
//
// Caso real: 20/10/2026, borderô 418817 — a tela desistiu em 120s, o servidor
// seguiu enviando e a nova tentativa (com a 1a ainda rodando) mandou o boleto
// 2 vezes para 10 clientes. A reserva (compare-and-set em disparado_em) faz a
// 2a requisicao pular o que a 1a ja pegou.

const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');

const emails = [];
const emailsCompletos = [];
require.cache[path.join(root, 'middlewares/requirePerm.js')] = { exports: () => () => (q, r, n) => n(), loaded: true, id: 'rp' };
require.cache[path.join(root, 'services/auditoria.js')] = { exports: { registrar: () => {} }, loaded: true, id: 'aud' };
require.cache[path.join(root, 'services/emailService.js')] = { exports: {
  SENDER_COBRANCA: 'cobranca@teste',
  sendEmail: async (m) => { if (m.to === 'falha@x.com') throw new Error('Graph 500'); emails.push(m.to); emailsCompletos.push(m); return { ok: true }; }
}, loaded: true, id: 'mail' };
delete process.env.SURI_TPL_BOLETO;

const linha = (id, extra = {}) => ({
  id, id_lote: 45, prefixo: 'PED', numero: '0834' + id, parcela: '15', cliente_cod: 'C' + id, cliente_loja: '01',
  nosso_numero: '0834521' + id, status_banco: 'REGISTRADO', disparado_em: null, disparado_em_txt: '', canais_disparo: null,
  cliente_nome: 'Cliente ' + id, valor: 100 + id, vencimento: '20261203', tipo: 'DP',
  banco_cod: '341', banco_nome: 'Itaú', banco_agencia: '0298', banco_conta: '25776', ...extra
});
const ROWS = [
  linha(1),                                                     // livre -> envia
  linha(2),                                                     // outra requisicao ja reservou -> pula
  linha(3),                                                     // envio falha -> desfaz reserva
  linha(4, { disparado_em: new Date('2026-10-20T13:50:00Z'), disparado_em_txt: '2026-10-20 10:50:00.123456-03' }), // recente -> pula
  // Grupo BFC (699): dispara como os outros (21/10/2026), boleto Bradesco com PDF do fundo
  linha(5, { id_lote: 37, prefixo: '1', numero: '091467', parcela: '02', nosso_numero: '99111230029', valor: 823.97, vencimento: '20261031',
    banco_cod: '699', banco_nome: 'GRUPO BFC', banco_agencia: '00000', banco_conta: '0000000000', data_ocorrencia: '20260930' })
];
const reservasNegadas = new Set([2, 4]);
const pg = [];
const Pg = { connectAndQuery: async (sql, p) => {
  pg.push({ sql, p });
  if (/FROM tab_boleto_envio_lote_retorno r/.test(sql)) { const pedidos = Object.values(p); return ROWS.filter(x => pedidos.includes(x.id)); }
  if (/SET disparado_em = NOW\(\)\s+WHERE id = @id\s+AND COALESCE/.test(sql)) {
    assert.ok(/@reenviar::int = 1/.test(sql) && /@janela::int \* INTERVAL '1 minute'/.test(sql));
    return reservasNegadas.has(p.id) ? [] : [{ id: p.id }];
  }
  return [];
} };
const Protheus = { connectAndQuery: async (sql) => {
  if (/FROM SA1010/.test(sql)) return ROWS.map(r => ({ cod: r.cliente_cod, loja: '01', nome: r.cliente_nome, cgc: '', email: r.id === 3 ? 'falha@x.com' : `c${r.id}@x.com`, ddd: '', tel: '' }));
  if (/FROM SE1010/.test(sql)) return ROWS.map(r => ({ prefixo: r.prefixo, numero: r.numero, parcela: r.parcela, cliente: r.cliente_cod, loja: '01', emissao: '20261001', vencto_original: '20261203', juros_dia: 0, multa_pct: 2 }));
  return [];
} };
const Suri = { normalizePhone: () => '', enviarTemplate: async () => ({ ok: false }) };
const app = { services: { Pg, Protheus, Suri } };
const handler = require(path.join(root, 'resources/financeiro/financeiro.boleto-disparar.js'))(app).handler;
const call = (body) => new Promise((ok) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { ok({ code: this.statusCode, body: b }); } };
  handler({ body, user: [{ ID: 1 }] }, res);
});

(async () => {
  const r = await call({ ids: [1, 2, 3, 4], canais: ['EMAIL'] });
  const b = r.body;
  const st = Object.fromEntries(b.resultados.map(x => [x.id, x.status]));
  console.log(JSON.stringify({ disparados: b.disparados, falhas: b.falhas, ja_disparados: b.ja_disparados, st }));
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(st, { 1: 'DISPARADO', 2: 'JA_DISPARADO', 3: 'FALHA', 4: 'JA_DISPARADO' });
  assert.strictEqual(b.disparados, 1); assert.strictEqual(b.falhas, 1); assert.strictEqual(b.ja_disparados, 2);
  assert.deepStrictEqual(emails, ['c1@x.com']);                    // so o livre foi ao cliente
  assert.ok(/Já disparado em 20\/10\/2026/.test(b.resultados.find(x => x.id === 4).mensagem));
  assert.ok(/em andamento/.test(b.resultados.find(x => x.id === 2).mensagem));
  // reserva do 4 usou o valor lido no inicio (compare-and-set)
  const ehReserva = (c) => /SET disparado_em = NOW\(\)\s+WHERE id = @id\s+AND COALESCE/.test(c.sql);
  const res4 = pg.find(c => ehReserva(c) && c.p.id === 4);
  assert.strictEqual(res4.p.ant, '2026-10-20 10:50:00.123456-03'); assert.strictEqual(res4.p.reenviar, 0); assert.strictEqual(res4.p.janela, 30);
  // falha no envio devolve a reserva
  const desfaz = pg.find(c => /NULLIF\(@ant, ''\)::timestamptz/.test(c.sql));
  assert.ok(desfaz && desfaz.p.id === 3 && desfaz.p.ant === '');
  // reenvio deliberado passa o flag
  pg.length = 0;
  await call({ ids: [4], canais: ['EMAIL'], reenviar: true });
  assert.strictEqual(pg.find(ehReserva).p.reenviar, 1);

  // Grupo BFC (699): sai como os outros — e-mail com PDF e banco "Bradesco"
  const rb = await call({ ids: [5], canais: ['EMAIL'] });
  assert.strictEqual(rb.body.resultados[0].status, 'DISPARADO', JSON.stringify(rb.body.resultados[0]));
  const mb = emailsCompletos.find(m => m.to === 'c5@x.com');
  assert.ok(mb && /Bradesco/.test(mb.html), 'e-mail do BFC cita o banco do boleto');
  assert.ok(mb.attachments && mb.attachments[0].content.length > 5000, 'PDF anexado');
  console.log('OK — reserva do disparo: todas as verificacoes passaram');
})().catch(e => { console.error(e); process.exit(1); });

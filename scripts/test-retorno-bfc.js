// Teste do registro pelo .RET do Grupo BFC (portador 699), com Protheus e
// Postgres simulados. Uso: node scripts/test-retorno-bfc.js
//
// Cobre: parser (uso da empresa em branco, seu numero "92276-3", DV 'P'), a
// resolucao pelo seu numero (unico, ambiguo, valor/vencimento divergente, nao
// localizado, baixado), os 3 destinos (atualizar, inserir em lote, lote
// retroativo), a trava de emissao do 699 e o nosso numero protegido na
// sincronizacao. Validado tambem contra o retorno real de 30/09/2026 e a SE1:
// 363/363 identificados, R$ 752.500,87.

const path = require('path'); const assert = require('assert');
const root = path.join(__dirname, '..');
const R = (p) => require(path.join(root, p));
const Cnab = R('services/cnabRetornoFiltro.js');

// Linha BFC: uso da empresa em branco, NN 71-82, ocor 109-110, seu 117-126, venc 147-152, valor 153-165
function linha({ nn, dv = '8', ocor = '02', seu, venc, valor, seq = 2 }) {
  const l = Array(400).fill(' ');
  const put = (pos1, s) => { for (let i = 0; i < s.length; i++) l[pos1 - 1 + i] = s[i]; };
  put(1, '1020960356000100 00000000000000016717');
  put(63, ('00000000' + nn).slice(-19) + dv);
  put(108, '9' + ocor + '300926'); put(117, seu.padEnd(10)); put(127, nn + dv);
  put(147, venc); put(153, String(Math.round(valor * 100)).padStart(13, '0')); put(166, '23729602');
  put(393, String(seq).padStart(8, '0'));
  return l.join('');
}
const H = '02RETORNO01COBRANCA       000000016717        GNATUS                        237BFC FIDIC      161026'.padEnd(400);
const T = '9'.padEnd(400, '0');
const L = [
  linha({ nn: '99111230139', seu: '92276-3', venc: '241226', valor: 329.74 }),          // ja tem linha de retorno (NN do Protheus) -> atualizar
  linha({ nn: '99111230138', dv: 'P', seu: '92276-2', venc: '241126', valor: 329.73 }), // em lote sem retorno -> inserir
  linha({ nn: '99111230137', seu: '88281-10', venc: '100127', valor: 1000 }),           // fora de lote -> adotar
  linha({ nn: '99111230136', seu: '91000-1', venc: '100127', valor: 50 }),              // valor divergente
  linha({ nn: '99111230135', seu: '91001-1', venc: '100127', valor: 60 }),              // ambiguo
  linha({ nn: '99111230134', seu: '91002-1', venc: '100127', valor: 70 }),              // nao localizado
  linha({ nn: '99111230133', seu: '91003-2', venc: '100127', valor: 80 }),              // vencimento divergente
  linha({ nn: '99111230132', seu: '91004-1', venc: '100127', valor: 90 }),              // baixado
];
const arquivo = [H, ...L, T].join('\r\n') + '\r\n';

// --- parser
const det = Cnab.parseDetalhesBradesco(arquivo);
assert.strictEqual(det.length, 8);
assert.strictEqual(det[0].numero, ''); assert.strictEqual(det[0].seuNumero, '92276-3');
assert.strictEqual(det[0].nossoNumero, '99111230139'); assert.strictEqual(det[1].dvNossoNumero, 'P');
assert.strictEqual(det[0].vencimento, '241226'); assert.strictEqual(det[0].valor, 329.74);
assert.deepStrictEqual(Cnab.chaveDoSeuNumero('92276-3'), { numero: '92276', parcela: '3' });
assert.deepStrictEqual(Cnab.chaveDoSeuNumero('88281-10'), { numero: '88281', parcela: '10' });
assert.deepStrictEqual(Cnab.chaveDoSeuNumero('092276-03'), { numero: '92276', parcela: '3' });
assert.strictEqual(Cnab.chaveDoSeuNumero('PED094610'), null);
assert.strictEqual(Cnab.chaveDoSeuNumero(''), null);

// --- SE1 simulada (portador 699)
const SE1 = [
  { prefixo: '1', numero: '092276', parcela: '03', valor: 329.74, vencto: '20261224', vencrea: '20261224', tipo: 'NF', cliente_cod: 'C1', cliente_loja: '01', portador: '699', agencia: '00000', conta: '0000000000', numbor: '418809', status: 'A', baixa: '' },
  { prefixo: '1', numero: '092276', parcela: '02', valor: 329.73, vencto: '20261124', vencrea: '20261124', tipo: 'NF', cliente_cod: 'C1', cliente_loja: '01', portador: '699', agencia: '00000', conta: '0000000000', numbor: '418809', status: 'A', baixa: '' },
  { prefixo: 'PED', numero: '088281', parcela: '10', valor: 1000, vencto: '20270110', vencrea: '20270110', tipo: 'DP', cliente_cod: 'C2', cliente_loja: '01', portador: '699', agencia: '00000', conta: '0000000000', numbor: '418810', status: 'A', baixa: '' },
  { prefixo: '1', numero: '091000', parcela: '01', valor: 55, vencto: '20270110', vencrea: '20270110', tipo: 'NF', portador: '699' },
  { prefixo: '1', numero: '091001', parcela: '01', valor: 60, vencto: '20270110', vencrea: '20270110', tipo: 'NF', portador: '699' },
  { prefixo: 'PED', numero: '091001', parcela: '01', valor: 60, vencto: '20270110', vencrea: '20270110', tipo: 'DP', portador: '699' },
  { prefixo: '1', numero: '091003', parcela: '02', valor: 80, vencto: '20270210', vencrea: '20270210', tipo: 'NF', portador: '699' },
  { prefixo: '1', numero: '091004', parcela: '01', valor: 90, vencto: '20270110', vencrea: '20270110', tipo: 'NF', cliente_cod: 'C3', cliente_loja: '01', portador: '699', numbor: '418809', status: 'B', baixa: '20261001' },
  { prefixo: '1', numero: '092276', parcela: '03', valor: 999, vencto: '20261224', tipo: 'NF', portador: '033' } // outro portador: o SQL filtra
];
const protheusSql = [];
const Protheus = { connectAndQuery: async (sql, p) => {
  protheusSql.push(sql);
  if (/E1_PORTADO\)=@port/.test(sql)) {
    const nums = Object.keys(p).filter(k => /^n\d+$/.test(k)).map(k => p[k]);
    return SE1.filter(x => x.portador === p.port && nums.includes(x.numero));
  }
  if (/E1_STATUS\) status/.test(sql)) {
    const ks = Object.keys(p).filter(k => /^pf\d+$/.test(k)).map(k => { const j = k.slice(2); return `${p['pf' + j]}|${p['nu' + j]}|${p['pa' + j]}`; });
    return SE1.filter(x => x.portador === '699' && ks.includes(`${x.prefixo}|${x.numero}|${x.parcela}`));
  }
  if (/FROM SA1010/.test(sql)) return [];
  throw new Error('Protheus SQL inesperado: ' + sql.slice(0, 80));
} };
const pgCalls = [];
let loteSeq = 900;
const temChave = (p, nu, pa) => Object.keys(p).some(k => /^nu\d+$/.test(k) && p[k] === nu && p['pa' + k.slice(2)] === pa);
const Pg = { connectAndQuery: async (sql, p) => {
  pgCalls.push({ sql, p });
  if (/FROM tab_boleto_envio_lote_retorno WHERE \(/.test(sql)) {
    return temChave(p, '092276', '03')
      ? [{ id: 11, id_lote: 5, prefixo: '1', numero: '092276', parcela: '03', status_banco: 'PENDENTE', nosso_numero: '00006630210', bordero_protheus: '418809' }] : [];
  }
  if (/FROM tab_boleto_envio_lote_titulo t/.test(sql)) {
    return temChave(p, '092276', '02')
      ? [{ id_lote: 5, prefixo: '1', numero: '092276', parcela: '02', cliente_cod: 'C1', cliente_loja: '01', lote_protheus: '418809' }] : [];
  }
  if (/INSERT INTO tab_boleto_envio_lote\s/.test(sql)) return [{ id: ++loteSeq }];
  return [];
} };
const app = { services: { Pg, Protheus } };
require.cache[path.join(root, 'middlewares/requirePerm.js')] = { exports: () => () => (q, r, n) => n(), loaded: true, id: 'rp' };
require.cache[path.join(root, 'services/auditoria.js')] = { exports: { registrar: () => {} }, loaded: true, id: 'aud' };
const handler = R('resources/financeiro/financeiro.boleto-adotar-retorno.js')(app).handler;
const call = (body) => new Promise((ok) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { ok({ code: this.statusCode, body: b }); } };
  handler({ body, user: [{ ID: 1, NOME: 'teste' }] }, res);
});

(async () => {
  const b64 = Buffer.from(arquivo, 'latin1').toString('base64');
  const sim = await call({ conteudo_base64: b64, banco: '699', simular: true });
  const b = sim.body;
  console.log(JSON.stringify({ ...b, nao_identificados_lista: (b.nao_identificados_lista || []).map(x => x.seuNumero + ':' + x.motivo) }));
  assert.strictEqual(b.criterio, 'seu_numero');
  assert.strictEqual(b.candidatos, 8);
  assert.strictEqual(b.identificados, 4);
  assert.strictEqual(b.a_atualizar, 1); assert.strictEqual(b.a_inserir, 1); assert.strictEqual(b.a_adotar, 1);
  assert.strictEqual(b.ja_baixados, 1); assert.strictEqual(b.orfaos, 0);
  assert.deepStrictEqual(b.nao_identificados_por_motivo, { VALOR_DIVERGENTE: 1, AMBIGUO: 1, NAO_LOCALIZADO: 1, VENCIMENTO_DIVERGENTE: 1 });
  assert.strictEqual(b.boleto_pelo_fundo, true);
  assert.ok(!pgCalls.some(c => /UPDATE|INSERT/.test(c.sql)), 'simulacao nao pode gravar');
  assert.ok(protheusSql.filter(s => /E1_STATUS\) status/.test(s)).every(s => /NOT IN \('RA','NCC'\)/.test(s)));

  pgCalls.length = 0;
  const real = await call({ conteudo_base64: b64, banco: '699', simular: false });
  assert.strictEqual(real.body.atualizados, 3, JSON.stringify(real.body));
  const upd = pgCalls.find(c => /UPDATE tab_boleto_envio_lote_retorno/.test(c.sql));
  assert.strictEqual(upd.p.nn, '99111230139');                      // NN do fundo substitui o do Protheus
  const ins = pgCalls.find(c => /INSERT INTO tab_boleto_envio_lote_retorno/.test(c.sql) && c.p.id === 5);
  assert.strictEqual(ins.p.nn, '99111230138'); assert.strictEqual(ins.p.par, '02');
  const adot = pgCalls.filter(c => /INSERT INTO tab_boleto_envio_lote_retorno/.test(c.sql) && c.p.id > 900);
  assert.strictEqual(adot.length, 1); assert.strictEqual(adot[0].p.nn, '99111230137'); assert.strictEqual(adot[0].p.num, '088281');
  const loteNovo = pgCalls.find(c => /INSERT INTO tab_boleto_envio_lote\s/.test(c.sql));
  assert.ok(/Grupo BFC/.test(loteNovo.p.bnom), loteNovo.p.bnom);
  const st = pgCalls.find(c => /UPDATE tab_boleto_envio_lote\s+SET status = CASE/.test(c.sql));
  assert.ok(st && /'ENVIADO_PROTHEUS'/.test(st.sql));

  // --- portadorCessao: 699 nunca emite, mesmo com coordenadas no .env
  process.env.PORTADOR_699_AGENCIA = '1234'; process.env.PORTADOR_699_CONTA = '1234567'; process.env.PORTADOR_699_CARTEIRA = '09';
  const PC = R('services/portadorCessao.js');
  const bk = PC.dadosBoleto({ banco: '699' });
  assert.strictEqual(bk.boletoPendente, true); assert.strictEqual(bk.boletoPeloFundo, true);
  assert.ok(/emitido e enviado pelo próprio fundo/.test(bk.motivo));
  assert.strictEqual(PC.dadosBoleto({ banco: '044' }).boletoPendente, undefined);   // Acreditar intacto

  // --- sincronizar: lote de cessao nao leva o E1_NUMBCO; Santander igual a antes
  const syncPg = []; const S = R('services/boletoSincronizar.js');
  const PgS = { connectAndQuery: async (sql, p) => { syncPg.push({ sql, p });
    if (/FROM tab_boleto_envio_lote WHERE id/.test(sql)) return [{ id: p.id, status: 'ENVIADO_PROTHEUS', banco_cod: p.id === 5 ? '699' : '033' }];
    if (/FROM tab_boleto_envio_lote_titulo WHERE id_lote/.test(sql)) return [{ prefixo: '1', numero: '092276', parcela: '03', cliente_cod: 'C1', cliente_loja: '01' }];
    return []; } };
  const PrS = { connectAndQuery: async () => [{ prefixo: '1', numero: '092276', parcela: '03', cliente_cod: 'C1', cliente_loja: '01', ocorren: '', bordero: '418809', nosso_numero: '00006630210', data_baixa: '', valor_liquidado: 0 }] };
  await S.sincronizarLote({ Pg: PgS, Protheus: PrS, id: 5 });
  assert.strictEqual(syncPg.find(c => /INSERT INTO tab_boleto_envio_lote_retorno/.test(c.sql)).p.nn, null);
  syncPg.length = 0;
  await S.sincronizarLote({ Pg: PgS, Protheus: PrS, id: 6 });
  assert.strictEqual(syncPg.find(c => /INSERT INTO tab_boleto_envio_lote_retorno/.test(c.sql)).p.nn, '00006630210');

  // --- adotarSe1 exclui cessao
  const sqls = []; const A = R('services/boletoAdotar.js');
  await A.adotarSe1({ Pg: { connectAndQuery: async () => [] }, Protheus: { connectAndQuery: async (s, p) => { sqls.push({ s, p }); return []; } }, user: {} });
  assert.ok(/E1_PORTADO\) NOT IN \(@ces0,@ces1\)/.test(sqls[0].s), sqls[0].s);
  assert.deepStrictEqual([sqls[0].p.ces0, sqls[0].p.ces1].sort(), ['044', '699']);
  console.log('OK — todas as verificacoes passaram');
})().catch(e => { console.error(e); process.exit(1); });

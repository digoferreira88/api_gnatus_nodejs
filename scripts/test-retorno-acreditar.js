// Teste do retorno e do boleto do ACREDITAR FIDC (portador 044) no formato de
// PRODUCAO, com Protheus e Postgres simulados. Uso: node scripts/test-retorno-acreditar.js
//
// Base real (24/11/2026): retornos RT20261029_178879_237_FIDC.RET (113 entradas
// confirmadas + 16 rejeitadas) e RT20261103_..._FIDC.RET (as mesmas 113), do
// borderô 418826, e o boleto do fundo C/002043/05 (docs/FIDIC/Acreditar/).
// Diferente do arquivo de teste de agosto: uso da empresa EM BRANCO, seu numero
// "082830/17" (barra) e vencimento = E1_VENCREA.
//
// Cobre: parser + chave pelo seu numero com barra, rejeicoes (03) listadas, o
// vencimento registrado gravado nos 3 destinos, a precedencia do vencimento no
// boleto, e a ficha do fundo campo a campo (linha digitavel identica a do PDF).

const path = require('path'); const assert = require('assert');
const fs = require('fs');
const root = path.join(__dirname, '..');
const R = (p) => require(path.join(root, p));
const Cnab = R('services/cnabRetornoFiltro.js');

// Linha no layout do retorno de producao: uso da empresa em branco, NN 71-82,
// ocor 109-110, data 111-116, seu numero 117-126, NN repetido 127-146,
// vencimento 147-152, valor 153-165, banco 166-168.
function linha({ nn, dv, ocor = '02', data = '291026', seu, venc, valor, seq = 2 }) {
  const l = Array(400).fill(' ');
  const put = (pos1, s) => { for (let i = 0; i < s.length; i++) l[pos1 - 1 + i] = s[i]; };
  put(1, '102' + '00000000000191' + '00000000000000000000');
  const nnDv = nn ? nn + dv : '000000000000';
  put(63, ('00000000' + nnDv).slice(-20));
  put(83, '          000000000000 009' + ocor + data);
  put(117, seu.padEnd(10)); put(127, ('00000000' + nnDv).slice(-20));
  put(147, venc); put(153, String(Math.round(valor * 100)).padStart(13, '0')); put(166, '23700000');
  put(319, '0000000000');
  put(395, String(seq).padStart(6, '0'));
  return l.join('');
}
const H = '02RETORNO01COBRANCA       00000000000000000000                              237BRADESCO       1811260000000000014'.padEnd(394) + '000001';
const T = '9201237'.padEnd(394, ' ') + '000099';
const L = [
  linha({ nn: '00000031912', dv: '3', seu: '002043/05', venc: '110127', valor: 979.17 }),  // ja tem linha REGISTRADO, sem vencimento -> atualizar
  linha({ nn: '00000031878', dv: 'P', seu: '082830/17', venc: '220327', valor: 2708.11 }), // em lote sem retorno -> inserir
  linha({ nn: '00000031950', dv: '1', seu: '090107/06', venc: '110127', valor: 500 }),     // fora de lote -> adotar
  linha({ nn: '', ocor: '03', seu: '089141/07', venc: '120127', valor: 16564.9 }),          // rejeitada pelo fundo
];
const arquivo = [H, ...L, T].join('\r\n') + '\r\n';

// --- parser
const det = Cnab.parseDetalhesBradesco(arquivo);
assert.strictEqual(det.length, 4);
assert.strictEqual(det[0].numero, ''); assert.strictEqual(det[0].seuNumero, '002043/05');
assert.strictEqual(det[0].nossoNumero, '00000031912'); assert.strictEqual(det[1].dvNossoNumero, 'P');
assert.strictEqual(det[0].vencimento, '110127'); assert.strictEqual(det[0].valor, 979.17);
assert.strictEqual(det[3].ocorrencia, '03'); assert.strictEqual(det[3].nossoNumero, '00000000000');
assert.deepStrictEqual(Cnab.chaveDoSeuNumero('082830/17'), { numero: '82830', parcela: '17' });
assert.deepStrictEqual(Cnab.chaveDoSeuNumero('002043/05'), { numero: '2043', parcela: '5' });
assert.deepStrictEqual(Cnab.chaveDoSeuNumero('92276-3'), { numero: '92276', parcela: '3' });  // BFC continua
assert.strictEqual(Cnab.chaveDoSeuNumero('002043/'), null);
assert.strictEqual(Cnab.chaveDoSeuNumero('C/002043/05'), null);

// --- SE1 simulada (portador 044, borderô 418826). VENCTO cai no domingo, o
// banco registrou o VENCREA (segunda) — como em 45 dos 113 titulos reais.
const SE1 = [
  { prefixo: 'C', numero: '002043', parcela: '05', valor: 979.17, vencto: '20270110', vencrea: '20270111', vencimento: '20270111', tipo: 'NF', cliente_cod: '169730', cliente_loja: '01', portador: '044', agencia: '00000', conta: '0000000000', numbor: '418826', status: 'A', baixa: '' },
  { prefixo: '1', numero: '082830', parcela: '17', valor: 2708.11, vencto: '20270320', vencrea: '20270322', vencimento: '20270322', tipo: 'NF', cliente_cod: '168011', cliente_loja: '01', portador: '044', agencia: '00000', conta: '0000000000', numbor: '418826', status: 'A', baixa: '' },
  { prefixo: '1', numero: '090107', parcela: '06', valor: 500, vencto: '20270110', vencrea: '20270111', vencimento: '20270111', tipo: 'NF', cliente_cod: '169730', cliente_loja: '01', portador: '044', agencia: '00000', conta: '0000000000', numbor: '418826', status: 'A', baixa: '' },
  { prefixo: 'PED', numero: '090107', parcela: '06', valor: 77, vencto: '20260101', vencrea: '20260101', tipo: 'DP', portador: '' }  // mesmo numero, outro portador: o SQL filtra
];
const Protheus = { connectAndQuery: async (sql, p) => {
  if (/E1_PORTADO\)=@port/.test(sql)) {
    const nums = Object.keys(p).filter(k => /^n\d+$/.test(k)).map(k => p[k]);
    return SE1.filter(x => x.portador === p.port && nums.includes(x.numero));
  }
  if (/E1_STATUS\) status/.test(sql)) {
    const ks = Object.keys(p).filter(k => /^pf\d+$/.test(k)).map(k => { const j = k.slice(2); return `${p['pf' + j]}|${p['nu' + j]}|${p['pa' + j]}`; });
    return SE1.filter(x => x.portador === '044' && ks.includes(`${x.prefixo}|${x.numero}|${x.parcela}`));
  }
  if (/FROM SA1010/.test(sql)) return [];
  throw new Error('Protheus SQL inesperado: ' + sql.slice(0, 80));
} };
const pgCalls = [];
let loteSeq = 900;
const temChave = (p, nu, pa) => Object.keys(p).some(k => /^nu\d+$/.test(k) && p[k] === nu && p['pa' + k.slice(2)] === pa);
const Pg = { connectAndQuery: async (sql, p) => {
  pgCalls.push({ sql, p });
  if (/FROM tab_boleto_envio_lote_retorno r\s+JOIN tab_boleto_envio_lote l/.test(sql)) {
    assert.ok(/vencimento_banco/.test(sql));
    return temChave(p, '002043', '05')
      ? [{ id: 21, id_lote: 7, prefixo: 'C', numero: '002043', parcela: '05', status_banco: 'REGISTRADO', nosso_numero: '00000031912', bordero_protheus: '418826', data_ocorrencia: '20261029', vencimento_banco: '' }] : [];
  }
  if (/FROM tab_boleto_envio_lote_titulo t/.test(sql)) {
    return temChave(p, '082830', '17')
      ? [{ id_lote: 7, prefixo: '1', numero: '082830', parcela: '17', cliente_cod: '168011', cliente_loja: '01', lote_protheus: '418826' }] : [];
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
  const sim = await call({ conteudo_base64: b64, banco: '044', simular: true });
  const b = sim.body;
  assert.strictEqual(sim.code, 200, JSON.stringify(b));
  assert.strictEqual(b.criterio, 'seu_numero');
  assert.strictEqual(b.candidatos, 3); assert.strictEqual(b.identificados, 3);
  assert.strictEqual(b.nao_identificados, 0, JSON.stringify(b.nao_identificados_lista));
  // a linha ja REGISTRADA so volta para atualizacao porque falta o vencimento registrado
  assert.strictEqual(b.a_atualizar, 1); assert.strictEqual(b.a_inserir, 1); assert.strictEqual(b.a_adotar, 1);
  assert.strictEqual(b.rejeitados, 1);
  assert.deepStrictEqual(b.rejeitados_lista, [{ seuNumero: '089141/07', valor: 16564.9, vencimento: '20270112', motivos: '' }]);
  assert.ok(/1 entrada\(s\) rejeitada\(s\)/.test(b.mensagem), b.mensagem);
  assert.ok(!pgCalls.some(c => /UPDATE|INSERT/.test(c.sql)), 'simulacao nao pode gravar');

  pgCalls.length = 0;
  const real = await call({ conteudo_base64: b64, banco: '044', simular: false });
  assert.strictEqual(real.body.atualizados, 3, JSON.stringify(real.body));
  const upd = pgCalls.find(c => /UPDATE tab_boleto_envio_lote_retorno/.test(c.sql));
  assert.strictEqual(upd.p.venc, '20270111');                           // VENCREA, nao o VENCTO 20270110
  assert.ok(/vencimento_banco = COALESCE\(NULLIF\(@venc, ''\), vencimento_banco\)/.test(upd.sql));
  const ins = pgCalls.find(c => /INSERT INTO tab_boleto_envio_lote_retorno/.test(c.sql) && c.p.id === 7);
  assert.strictEqual(ins.p.venc, '20270322'); assert.strictEqual(ins.p.nn, '00000031878');
  const adot = pgCalls.find(c => /INSERT INTO tab_boleto_envio_lote_retorno/.test(c.sql) && c.p.id > 900);
  assert.strictEqual(adot.p.venc, '20270111'); assert.strictEqual(adot.p.num, '090107'); assert.strictEqual(adot.p.nn, '00000031950');
  assert.ok(/vencimento_banco/.test(adot.sql));

  // Mesmo arquivo de novo (o 2o retorno do fundo repete as 113): com tudo
  // gravado, nada a fazer.
  const PgOk = { connectAndQuery: async (sql, p) => {
    if (/FROM tab_boleto_envio_lote_retorno r\s+JOIN tab_boleto_envio_lote l/.test(sql)) {
      return temChave(p, '002043', '05')
        ? [{ id: 21, id_lote: 7, prefixo: 'C', numero: '002043', parcela: '05', status_banco: 'REGISTRADO', nosso_numero: '00000031912', bordero_protheus: '418826', data_ocorrencia: '20261029', vencimento_banco: '20270111' }] : [];
    }
    return [];
  } };
  const h2 = R('resources/financeiro/financeiro.boleto-adotar-retorno.js')({ services: { Pg: PgOk, Protheus } }).handler;
  const sim2 = await new Promise((ok) => h2({ body: { conteudo_base64: Buffer.from([H, L[0], T].join('\r\n'), 'latin1').toString('base64'), banco: '044' }, user: [{}] },
    { status() { return this; }, json: ok }));
  assert.strictEqual(sim2.ja_registrados, 1); assert.strictEqual(sim2.a_atualizar, 0);

  // --- vencimento do boleto: registrado > E1_VENCTO > lote
  const BoletoDocumento = R('services/boletoDocumento.js');
  assert.strictEqual(BoletoDocumento.vencimentoDoBoleto({ vencimento_banco: '20270111', vencimento: '20270111' }, { venctoOriginal: '20270110' }), '20270111');
  assert.strictEqual(BoletoDocumento.vencimentoDoBoleto({ vencimento_banco: null, vencimento: '20270111' }, { venctoOriginal: '20270110' }), '20270110');  // Santander/Itau: igual a antes
  assert.strictEqual(BoletoDocumento.vencimentoDoBoleto({ vencimento: '20270111' }, {}), '20270111');
  assert.ok(/EA_CART = 'R'/.test(BoletoDocumento.SQL_DATA_BORDERO));

  // --- ficha do fundo: modelo docs/FIDIC/Acreditar/002043_05.pdf
  const PC = R('services/portadorCessao.js');
  const BoletoPdf = R('services/boletoPdf.js'); const ProtheusBoleto = R('services/protheusBoleto.js');
  const LD = R('services/linhaDigitavel.js');
  const bk = PC.dadosBoleto({ banco: '044', agencia: '00000', conta: '0000000000' });
  assert.deepStrictEqual([bk.banco, bk.agencia, bk.conta, bk.carteira], ['237', '2372', '0039947', '09']);
  const lin = await ProtheusBoleto.linhaDigitavel({ banco: bk.banco, agencia: bk.agencia, conta: bk.conta, carteira: bk.carteira, nossoNumero: '00000031912', valor: 979.17, vencimento: '20270111' });
  assert.strictEqual(lin.body.linha_digitavel, '23792.37205 90000.003195 12003.994709 9 16880000097917');
  // com o E1_VENCTO (domingo) a linha sairia OUTRA — era o defeito
  const linVencto = await ProtheusBoleto.linhaDigitavel({ banco: bk.banco, agencia: bk.agencia, conta: bk.conta, carteira: bk.carteira, nossoNumero: '00000031912', valor: 979.17, vencimento: '20270110' });
  assert.notStrictEqual(linVencto.body.linha_digitavel, lin.body.linha_digitavel);

  const G = { nome: 'GNATUS PRODUTOS MEDICOS E ODONTOLOGICOS LTDA - EPP', cnpj: '09609356000100', endereco: 'AV DOS MACONS, 405' };
  const r = { prefixo: 'C', numero: '002043', parcela: '05', nosso_numero: '00000031912', valor: 979.17, data_ocorrencia: '20261029', vencimento_banco: '20270111' };
  const se1 = { emissao: '20260814', jurosDia: 0, multaPct: 0, dataBordero: '20261028' };
  const pag = { nome: 'GO DENTAL GROUP LTDA', cgc: '43946258000198' };
  const o = BoletoPdf.opcoesPdfBoleto({ bko: bk, r, pagador: pag, se1, venctoCalc: '20270111', lin, beneficiarioGnatus: G });
  assert.strictEqual(o.linhaDigitavel, '23792.37205 90000.003195 12003.994709 9 16880000097917');
  assert.deepStrictEqual(
    [o.vencimento, o.numeroDocumento, o.nossoNumero, o.dataDocumento, o.dataProcessamento, o.agencia, o.codigoBeneficiario, o.carteira, o.especieDoc],
    ['20270111', '002043/05', '00000031912-3', '20261028', undefined, '02372-0', '0039947-7', '9', 'DS']);
  assert.deepStrictEqual(o.beneficiario, { nome: 'ACREDITAR FUNDO I E D CREDITORIOS', cnpj: '29152636000130', endereco: '' });
  assert.strictEqual(o.beneficiarioFinal, G);
  assert.deepStrictEqual(o.instrucoes, [
    'ATENÇÃO: Título cedido à Acreditar FIDC.', 'Quitação válida exclusivamente por este boleto.', 'Não pague boletos emitidos por terceiros',
    'COBRAR MULTA DE R$ 68,54 APÓS O VENCIMENTO', 'JUROS MORATÓRIOS DE R$ 8,16']);
  assert.ok(/Bradesco/.test(o.localPagamento));
  // serie de produto: DM; sem a data do borderô cai na emissao
  const o1 = BoletoPdf.opcoesPdfBoleto({ bko: bk, r: { ...r, prefixo: '1' }, pagador: pag, se1: { emissao: '20260814' }, venctoCalc: '20270111', lin, beneficiarioGnatus: G });
  assert.strictEqual(o1.especieDoc, 'DM'); assert.strictEqual(o1.dataDocumento, '20260814');

  // Multa 7% e mora 1/120 do valor = o que a remessa registra no banco
  // (docs/FIDIC/CB140803.REM, posicoes 67-70 e 161-173) + o boleto do fundo.
  const remessa = [[3970.44, 33.09], [792.49, 6.60], [2055.00, 17.13], [1292.52, 10.77], [154.59, 1.29], [86.96, 0.72], [979.17, 8.16]];
  for (const [valor, moraDia] of remessa) {
    const ins2 = BoletoPdf.opcoesPdfBoleto({ bko: bk, r: { ...r, valor }, pagador: pag, se1, venctoCalc: '20270111', lin, beneficiarioGnatus: G }).instrucoes;
    const fmt = (v) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    assert.strictEqual(ins2[4], `JUROS MORATÓRIOS DE R$ ${fmt(moraDia)}`, `valor ${valor}`);
    assert.strictEqual(ins2[3], `COBRAR MULTA DE R$ ${fmt(Math.round(valor * 7) / 100)} APÓS O VENCIMENTO`, `multa ${valor}`);
  }
  assert.strictEqual(LD.nossoNumeroBradescoImpresso('09', '00000015765'), '09/00000015765-4');            // boleto de agosto (SHOP ODONTO)
  assert.strictEqual(LD.nossoNumeroBradescoImpresso('09', '00000031912', { semCarteira: true }), '00000031912-3');

  // PDF renderiza; sai em scripts/_out para conferencia visual com o modelo
  const buf = await BoletoPdf.gerarBoletoPdf(o);
  assert.ok(buf.length > 5000);
  const out = path.join(__dirname, '_out'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'boleto-acreditar-002043-05.pdf'), buf);
  console.log('OK — retorno e boleto Acreditar: todas as verificacoes passaram');
})().catch(e => { console.error(e); process.exit(1); });

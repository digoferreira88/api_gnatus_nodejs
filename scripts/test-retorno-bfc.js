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
  if (/FROM tab_boleto_envio_lote_retorno r\s+JOIN tab_boleto_envio_lote l/.test(sql)) {
    // so linhas de lotes DO banco do arquivo
    assert.ok(/TRIM\(l\.banco_cod\) = @banco/.test(sql) && p.banco === '699');
    return temChave(p, '092276', '03')
      ? [{ id: 11, id_lote: 5, prefixo: '1', numero: '092276', parcela: '03', status_banco: 'PENDENTE', nosso_numero: '00006630210', bordero_protheus: '418809' }] : [];
  }
  if (/FROM tab_boleto_envio_lote_titulo t/.test(sql)) {
    assert.ok(/TRIM\(l\.banco_cod\) = @banco/.test(sql) && p.banco === '699');
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
  assert.ok(/Ficam disparáveis/.test(b.mensagem));
  assert.ok(!pgCalls.some(c => /UPDATE|INSERT/.test(c.sql)), 'simulacao nao pode gravar');
  assert.ok(protheusSql.filter(s => /E1_STATUS\) status/.test(s)).every(s => /NOT IN \('RA','NCC'\)/.test(s)));

  pgCalls.length = 0;
  const real = await call({ conteudo_base64: b64, banco: '699', simular: false });
  assert.strictEqual(real.body.atualizados, 3, JSON.stringify(real.body));
  const upd = pgCalls.find(c => /UPDATE tab_boleto_envio_lote_retorno/.test(c.sql));
  assert.strictEqual(upd.p.nn, '99111230139');                      // NN do fundo substitui o do Protheus
  const ins = pgCalls.find(c => /INSERT INTO tab_boleto_envio_lote_retorno/.test(c.sql) && c.p.id === 5);
  assert.strictEqual(ins.p.nn, '99111230138'); assert.strictEqual(ins.p.par, '02');
  // data da entrada confirmada (.RET 111-116 = 300926) vai para a linha — e' a data do boleto do BFC
  assert.strictEqual(upd.p.doc, '20260930'); assert.strictEqual(ins.p.doc, '20260930');
  assert.ok(/data_ocorrencia = COALESCE\(NULLIF\(@doc, ''\), data_ocorrencia\)/.test(upd.sql));
  const adot = pgCalls.filter(c => /INSERT INTO tab_boleto_envio_lote_retorno/.test(c.sql) && c.p.id > 900);
  assert.strictEqual(adot.length, 1); assert.strictEqual(adot[0].p.nn, '99111230137'); assert.strictEqual(adot[0].p.num, '088281');
  const loteNovo = pgCalls.find(c => /INSERT INTO tab_boleto_envio_lote\s/.test(c.sql));
  assert.ok(/Grupo BFC/.test(loteNovo.p.bnom), loteNovo.p.bnom);
  const st = pgCalls.find(c => /UPDATE tab_boleto_envio_lote\s+SET status = CASE/.test(c.sql));
  assert.ok(st && /'ENVIADO_PROTHEUS'/.test(st.sql));

  // --- portadorCessao: 699 gera e dispara o boleto como os outros bancos
  //     (a trava "o fundo ja envia" foi retirada pelo usuario em 21/10/2026)
  const PC = R('services/portadorCessao.js');
  const bk = PC.dadosBoleto({ banco: '699' });
  assert.strictEqual(bk.boletoPendente, undefined);
  assert.deepStrictEqual([bk.banco, bk.agencia, bk.conta, bk.carteira], ['237', '2960', '0069000', '09']);
  assert.ok(!('disparoBloqueado' in bk));
  assert.deepStrictEqual(bk.regrasCobranca, { protestoDiasUteis: 3, multaPct: 2, jurosDiaPct: 0.4 });
  const b044 = PC.dadosBoleto({ banco: '044' });
  assert.strictEqual(b044.boletoPendente, undefined);   // Acreditar intacto
  assert.strictEqual(b044.regrasCobranca, null); assert.strictEqual(b044.pdf, null);

  // --- PDF do BFC = ficha do fundo (modelo docs/financeiro/boleto bfc.pdf, 1/091467/02)
  const BoletoPdf = R('services/boletoPdf.js'); const ProtheusBoleto = R('services/protheusBoleto.js');
  const L = R('services/linhaDigitavel.js');
  assert.strictEqual(L.nossoNumeroBradescoImpresso('09', '99111230029'), '09/99111230029-4');
  assert.strictEqual(L.nossoNumeroBradescoImpresso('09', '99111230138'), '09/99111230138-P');
  const rM = { numero: '091467', parcela: '02', nosso_numero: '99111230029', valor: 823.97, data_ocorrencia: '20260930' };
  const linM = await ProtheusBoleto.linhaDigitavel({ banco: bk.banco, agencia: bk.agencia, conta: bk.conta, carteira: bk.carteira, nossoNumero: rM.nosso_numero, valor: rM.valor, vencimento: '20261031' });
  const G = { nome: 'GNATUS PRODUTOS MEDICOS E ODONTOLOGICOS LTDA - EPP', cnpj: '09609356000100', endereco: 'AV DOS MACONS, 405' };
  const oM = BoletoPdf.opcoesPdfBoleto({ bko: bk, r: rM, pagador: {}, se1: { emissao: '20260901' }, venctoCalc: '20261031', lin: linM, beneficiarioGnatus: G });
  assert.strictEqual(oM.linhaDigitavel, '23792.96003 99911.123000 29006.900004 9 16160000082397');
  assert.deepStrictEqual(
    [oM.numeroDocumento, oM.nossoNumero, oM.dataDocumento, oM.dataProcessamento, oM.codigoBeneficiario, oM.especieMoeda, oM.labelBeneficiarioFinal],
    ['0091467-2', '09/99111230029-4', '20260930', '20260930', '0069000-7', 'R$', 'Sacador/Avalista']);
  assert.deepStrictEqual(oM.beneficiario, { nome: 'BFC FUNDO DE INVESTIMENTO EM DIREITOS CREDITÓRIOS', cnpj: '11507489000109', endereco: '' });
  assert.deepStrictEqual(oM.instrucoes, ['ENVIAR PARA CARTÓRIO APOS 3 DIAS ÚTEIS',
    'PAGAMENTO APOS O VENCIMENTO SERA ACRESCIDO DE MULTA DE 2% (R$ 16,48)', 'JUROS DE MORA R$ 3,30 AO DIA APÓS VENCIMENTO']);
  assert.ok((await BoletoPdf.gerarBoletoPdf(oM)).length > 5000);
  // sem a data da ocorrencia: cai na emissao e no dia de hoje, como os outros bancos
  const oSemData = BoletoPdf.opcoesPdfBoleto({ bko: bk, r: { ...rM, data_ocorrencia: null }, pagador: {}, se1: { emissao: '20260901' }, venctoCalc: '20261031', lin: linM, beneficiarioGnatus: G });
  assert.strictEqual(oSemData.dataDocumento, '20260901'); assert.strictEqual(oSemData.dataProcessamento, undefined);

  // --- Santander e Itau: montador unico reproduz a montagem antiga, campo a campo
  for (const [banco, ag, cc, nn, carteiraLin] of [['033', '0820', '130002086', '00191620', '101'], ['341', '0298', '25776', '08345215', '109']]) {
    const bkx = PC.dadosBoleto({ banco, agencia: ag, conta: cc });
    const linx = { body: { linha_digitavel: 'LD', codigo_barras: 'CB', carteira: carteiraLin, nosso_numero: '' } };
    const rx = { numero: '094610', parcela: '04', nosso_numero: nn, valor: 100, data_ocorrencia: '20261001' };
    const sx = { emissao: '20260901', jurosDia: 1.5, multaPct: 2 };
    const o = BoletoPdf.opcoesPdfBoleto({ bko: bkx, r: rx, pagador: { nome: 'X' }, se1: sx, venctoCalc: '20261101', lin: linx, beneficiarioGnatus: G });
    const antigo = {
      banco, beneficiario: G, beneficiarioFinal: null, pagador: { nome: 'X' }, valor: 100, vencimento: '20261101',
      numeroDocumento: '094610', dataDocumento: '20260901',
      nossoNumero: L.formatarNossoNumero(banco, nn), agencia: ag, conta: cc,
      carteira: { '101': 'PENH. ELETR', '109': '109' }[carteiraLin], especieDoc: { '341': 'DMI', '033': 'DM' }[banco],
      linhaDigitavel: 'LD', codigoBarras: 'CB',
      instrucoes: BoletoPdf.montarInstrucoes({ jurosDia: 1.5, multaPct: 2, valor: 100, vencimento: '20261101' })
    };
    for (const [k, v] of Object.entries(antigo)) assert.deepStrictEqual(o[k], v, `${banco}.${k}`);
    for (const k of ['labelBeneficiarioFinal', 'dataProcessamento', 'codigoBeneficiario', 'especieMoeda', 'localPagamento']) assert.strictEqual(o[k], undefined, `${banco}.${k}`);
  }

  // --- sincronizar: lote de cessao nao leva o E1_NUMBCO; Santander igual a antes
  const syncPg = []; const S = R('services/boletoSincronizar.js');
  const PgS = { connectAndQuery: async (sql, p) => { syncPg.push({ sql, p });
    if (/FROM tab_boleto_envio_lote WHERE id/.test(sql)) return [{ id: p.id, status: 'ENVIADO_PROTHEUS', banco_cod: p.id === 5 ? '699' : '033' }];
    if (/FROM tab_boleto_envio_lote_titulo WHERE id_lote/.test(sql)) return [{ prefixo: '1', numero: '092276', parcela: '03', cliente_cod: 'C1', cliente_loja: '01' }];
    return []; } };
  let portadorSe1 = '699', ocorSe1 = '';
  const PrS = { connectAndQuery: async (sql) => {
    assert.ok(/E1_TIPO\) NOT IN \('RA','NCC'\)/.test(sql));
    return [{ prefixo: '1', numero: '092276', parcela: '03', cliente_cod: 'C1', cliente_loja: '01', ocorren: ocorSe1, bordero: '418809', nosso_numero: '00006630210', data_baixa: '', valor_liquidado: 0, portador: portadorSe1 }];
  } };
  const insRet = () => syncPg.find(c => /INSERT INTO tab_boleto_envio_lote_retorno/.test(c.sql)).p;
  await S.sincronizarLote({ Pg: PgS, Protheus: PrS, id: 5 });
  assert.strictEqual(insRet().nn, null);                         // cessao: NN nunca vem da SE1
  syncPg.length = 0; portadorSe1 = '033';
  await S.sincronizarLote({ Pg: PgS, Protheus: PrS, id: 6 });
  assert.strictEqual(insRet().nn, '00006630210');                // Santander no proprio banco: igual a antes

  // --- borderô 418817 (19/10): titulo de lote Santander que foi para o Itau
  syncPg.length = 0; portadorSe1 = '341'; ocorSe1 = '21';
  await S.sincronizarLote({ Pg: PgS, Protheus: PrS, id: 6 });
  const tr = insRet();
  assert.strictEqual(tr.status, 'TRANSFERIDO');                  // sai do disparo/PDF/portal (exigem REGISTRADO)
  assert.ok(/portador 341 \(borderô 418809\)/.test(tr.oc_desc), tr.oc_desc);
  assert.strictEqual(tr.nn, null); assert.strictEqual(tr.bord, null);  // nada do outro banco
  syncPg.length = 0; portadorSe1 = '';                            // devolvido a carteira
  await S.sincronizarLote({ Pg: PgS, Protheus: PrS, id: 6 });
  assert.strictEqual(insRet().status, 'TRANSFERIDO'); assert.ok(/sem portador/.test(insRet().oc_desc));

  // --- adotarSe1 exclui cessao
  const sqls = []; const A = R('services/boletoAdotar.js');
  await A.adotarSe1({ Pg: { connectAndQuery: async () => [] }, Protheus: { connectAndQuery: async (s, p) => { sqls.push({ s, p }); return []; } }, user: {} });
  assert.ok(/E1_PORTADO\) NOT IN \(@ces0,@ces1\)/.test(sqls[0].s), sqls[0].s);
  assert.deepStrictEqual([sqls[0].p.ces0, sqls[0].p.ces1].sort(), ['044', '699']);
  console.log('OK — todas as verificacoes passaram');
})().catch(e => { console.error(e); process.exit(1); });

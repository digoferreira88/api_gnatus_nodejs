// Teste do boleto do banco 310 (Vortx DTVM / Grafeno, cobranca em garantia da
// DelMonte). Uso: node scripts/test-boleto-310.js
//
// Base real:
//   - exemplo do manual da Vortx ("Banco 310 - V1.1", p. 20-24), repassado pelo
//     Diego em 24/11/2026: 31090.01903 00000.026005 00000.572156 1 39330000283743;
//   - SE1/SA6/SEE de producao lidos em 24/11/2026: SA6 recno 171 "DEL MONTE",
//     ag 0001 (DV vazio no SA6; 0001-9 no manual), conta 11974615-4, SEE 102
//     carteira 021; titulos de teste do borderô 001523 com E1_NUMBCO de 11 digitos
//     e E1_OCORREN vazio (o 310 nao tem retorno);
//   - nosso numero formatado citado pelo Diego (COBR001 R44): 00010008878-9.
//
// Cobre: campo livre e linha digitavel, DV do nosso numero, trava quando a
// conta nao e' a cadastrada (nunca adivinhar DV), dados efetivos do boleto
// (nao e' cessao), ficha do PDF, planejamento da confirmacao por borderô e o
// endpoint POST /financeiro/boleto-310-confirmar com Protheus/Postgres simulados.

const path = require('path'); const assert = require('assert');
const root = path.join(__dirname, '..');
const R = (p) => require(path.join(root, p));

const L = R('services/linhaDigitavel.js');
const ProtheusBoleto = R('services/protheusBoleto.js');
const PortadorCessao = R('services/portadorCessao.js');
const BoletoPdf = R('services/boletoPdf.js');
const BoletoVortx = R('services/boletoVortx.js');

(async () => {
  // ---- 1) Exemplo do manual: campo livre = ag+DV(4) + conta+DV(10) + NN(11) ----
  const vencManual = new Date(Date.UTC(2025, 1, 22) + (3933 - 1000) * 86400000);   // fator 3933
  const ex = L.calcular({ banco: '310', agencia: '0001', agenciaDv: '9', conta: '26', contaDv: '0',
    nossoNumero: '00000057215', valor: 2837.43, vencimento: vencManual });
  assert.strictEqual(ex.linhaDigitavel, '31090.01903 00000.026005 00000.572156 1 39330000283743');
  assert.strictEqual(ex.codigoBarras.slice(19), '0019' + '0000000260' + '00000057215');

  // Sem os digitos a linha sairia com campo livre errado e sem reclamar: recusa.
  assert.throws(() => L.calcular({ banco: '310', agencia: '0001', conta: '11974615', nossoNumero: '00010008878',
    valor: 10, vencimento: '20270512' }), /digito/i);

  // ---- 2) DV do nosso numero (mod 11 base 7 sobre "21" + NN, resto 0/1 -> 0) ----
  assert.strictEqual(L.formatarNossoNumero('310', '00010008878'), '00010008878-9');   // o do handoff
  assert.strictEqual(L.formatarNossoNumero('310', '10008879'), '00010008879-7');
  assert.strictEqual(L.dvNossoNumeroVortx('00010008877'), '0');                       // resto 1 -> 0, sem "P"
  assert.strictEqual(L.dvNossoNumeroVortx('00010008880'), '0');

  // ---- 3) ProtheusBoleto resolve os digitos da conta cadastrada (SA6 171) ----
  const lin = await ProtheusBoleto.linhaDigitavel({ banco: '310', agencia: '0001', conta: '11974615',
    nossoNumero: '00010008878', valor: 5086.63, vencimento: '20270512' });
  assert.ok(lin.ok, JSON.stringify(lin.body));
  assert.strictEqual(lin.body.linha_digitavel, '31090.01903 11974.615400 00100.088780 1 18090000508663');
  assert.strictEqual(lin.body.carteira, '021');
  assert.strictEqual(lin.body.codigo_barras.slice(19, 23), '0019');
  assert.strictEqual(lin.body.codigo_barras.slice(23, 33), '0119746154');

  // Conta que nao e' a cadastrada: nao calcula (o DV seria chute).
  const outra = await ProtheusBoleto.linhaDigitavel({ banco: '310', agencia: '0001', conta: '99999999',
    nossoNumero: '00010008878', valor: 5086.63, vencimento: '20270512' });
  assert.strictEqual(outra.ok, false);
  assert.strictEqual(outra.body.codigo_erro, 'CONTA_310_DESCONHECIDA');

  // ---- 4) Dados efetivos do boleto: banco proprio, nao cessao ----
  assert.strictEqual(PortadorCessao.ehCessao('310'), false);          // sincronizar leva o NN da SE1
  const bko = PortadorCessao.dadosBoleto({ banco: '310', agencia: '0001', conta: '11974615' });
  assert.strictEqual(bko.cessao, false);
  assert.strictEqual(bko.banco, '310');
  assert.strictEqual(bko.carteira, '021');
  assert.strictEqual(bko.pdf.agenciaImpressa, '0001-9');
  assert.strictEqual(bko.pdf.codigoBeneficiario, '11974615-4');
  // Itau/Santander continuam sem layout proprio.
  assert.strictEqual(PortadorCessao.dadosBoleto({ banco: '341', agencia: '0298', conta: '25776' }).pdf, undefined);

  // ---- 5) Ficha do PDF ----
  assert.strictEqual(BoletoPdf.BANCOS['310'].codigo, '310-7');
  const BENEF = { nome: 'GNATUS PRODUTOS MEDICOS E ODONTOLOGICOS LTDA - EPP', cnpj: '09609356000100', endereco: 'AV DOS MACONS, 405' };
  const r = { prefixo: '1', numero: '089853', parcela: '05', valor: 5086.63, nosso_numero: '00010008878' };
  const op = BoletoPdf.opcoesPdfBoleto({ bko, r, pagador: { nome: 'CLIENTE TESTE' },
    se1: { emissao: '20260716', jurosDia: 0, multaPct: 0 }, venctoCalc: '20270512', lin, beneficiarioGnatus: BENEF });
  assert.strictEqual(op.banco, '310');
  assert.strictEqual(op.beneficiario.nome, BENEF.nome);               // beneficiario = Gnatus (decisao 24/11)
  assert.strictEqual(op.beneficiarioFinal, null);
  assert.strictEqual(op.nossoNumero, '00010008878-9');
  assert.strictEqual(op.agencia, '0001-9');
  assert.strictEqual(op.codigoBeneficiario, '11974615-4');
  assert.strictEqual(op.carteira, '21');
  assert.strictEqual(op.linhaDigitavel, lin.body.linha_digitavel);
  const pdf = await BoletoPdf.gerarBoletoPdf(op);
  assert.ok(Buffer.isBuffer(pdf) && pdf.slice(0, 4).toString() === '%PDF');

  // ---- 6) Planejamento da confirmacao por borderô ----
  const se = (o) => ({ prefixo: 'PED', numero: '098700', parcela: '01', tipo: 'DP', cliente_cod: '170000', cliente_loja: '01',
    numbco: '00010008890', portador: '310', agencia: '0001', conta: '11974615', bordero: '001524',
    valor: 100, saldo: 100, status: 'A', vencimento: '20270101', ...o });
  const plano = BoletoVortx.planejarConfirmacao({
    bordero: '001524',
    titulos: [
      se({ numero: '098701' }),                                         // ok
      se({ numero: '098702', status: 'B', saldo: 0 }),                  // baixado
      se({ numero: '098703', numbco: '' }),                             // sem nosso numero
      se({ numero: '098704', conta: '22222222' }),                      // outra conta
      se({ numero: '098705' }),                                         // ja num lote 310
      se({ numero: '098706' }),                                         // REGISTRADO num lote Itau
      se({ numero: '098707' })                                          // lote Santander ja TRANSFERIDO -> pode
    ],
    emLotes: {
      'PED|098705|01|170000|01': [{ id_lote: 10, banco_cod: '310', status_banco: 'REGISTRADO' }],
      'PED|098706|01|170000|01': [{ id_lote: 11, banco_cod: '341', status_banco: 'REGISTRADO' }],
      'PED|098707|01|170000|01': [{ id_lote: 12, banco_cod: '033', status_banco: 'TRANSFERIDO' }]
    }
  });
  assert.deepStrictEqual(plano.a_confirmar.map((t) => t.numero), ['098701', '098707']);
  assert.deepStrictEqual(plano.ja_confirmados.map((t) => t.titulo), ['PED/098705/01']);
  assert.deepStrictEqual(plano.ignorados.map((t) => `${t.titulo}:${t.motivo}`), [
    'PED/098702/01:TITULO_BAIXADO', 'PED/098703/01:SEM_NOSSO_NUMERO',
    'PED/098704/01:CONTA_DIVERGENTE', 'PED/098706/01:EM_LOTE_OUTRO_BANCO'
  ]);
  // Borderô de teste: nada vira disparavel, nem com confirmacao.
  const teste = BoletoVortx.planejarConfirmacao({ bordero: '001523', titulos: [se({ bordero: '001523' })], emLotes: {} });
  assert.strictEqual(teste.a_confirmar.length, 0);
  assert.strictEqual(teste.bordero_teste, true);

  // ---- 7) Endpoint com Protheus/Postgres simulados ----
  const SE1_001524 = [se({ numero: '098801', numbco: '00010008891', valor: 2500, saldo: 2500 }),
                      se({ numero: '098802', numbco: '00010008892', valor: 3425, saldo: 3425 })];
  const pgLog = [];
  const Pg = { connectAndQuery: async (sql, p) => {
    pgLog.push({ sql, p });
    if (/INSERT INTO tab_boleto_envio_lote\s*\(/.test(sql)) return [{ id: 900 }];
    return [];
  } };
  const Protheus = { connectAndQuery: async (sql) => (/FROM SE1010/.test(sql) ? SE1_001524 : []) };
  const app = { services: { Pg, Protheus } };
  const handler = R('resources/financeiro/financeiro.boleto-310-confirmar.js')(app).handler;
  const chamar = (body) => new Promise((ok) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { ok({ code: this.statusCode, body: b }); } };
    handler({ body, user: [{ ID: 1, NOME: 'teste' }] }, res);
  });

  assert.strictEqual((await chamar({ bordero: 'abc' })).code, 400);

  const sim = await chamar({ bordero: '1524' });                         // simular e' o default
  assert.strictEqual(sim.code, 200, JSON.stringify(sim.body));
  assert.strictEqual(sim.body.simular, true);
  assert.strictEqual(sim.body.a_confirmar, 2);
  assert.strictEqual(sim.body.valor_a_confirmar, 5925);
  assert.ok(!pgLog.some((q) => /INSERT/.test(q.sql)), 'simulacao nao pode gravar');

  const semOk = await chamar({ bordero: '001524', simular: false });
  assert.strictEqual(semOk.code, 400);
  assert.strictEqual(semOk.body.codigo_erro, 'CONFIRMACAO_OBRIGATORIA');
  assert.ok(!pgLog.some((q) => /INSERT/.test(q.sql)));

  const real = await chamar({ bordero: '001524', simular: false, confirmado_delmonte: true });
  assert.strictEqual(real.code, 200, JSON.stringify(real.body));
  assert.strictEqual(real.body.confirmados, 2);
  const insLote = pgLog.find((q) => /INSERT INTO tab_boleto_envio_lote\s*\(/.test(q.sql));
  assert.strictEqual(insLote.p.bcod, '310');
  const insRet = pgLog.filter((q) => /INSERT INTO tab_boleto_envio_lote_retorno/.test(q.sql));
  assert.deepStrictEqual(insRet.map((q) => q.p.nn), ['00010008891', '00010008892']);   // NN da SE1

  const borTeste = await chamar({ bordero: '001523', simular: false, confirmado_delmonte: true });
  assert.strictEqual(borTeste.code, 409);
  assert.strictEqual(borTeste.body.codigo_erro, 'BORDERO_TESTE');

  console.log('OK — boleto 310 (Vortx): todas as verificacoes passaram');
})().catch((e) => { console.error('FALHOU:', e.message); console.error(e.stack.split('\n').slice(1, 4).join('\n')); process.exit(1); });

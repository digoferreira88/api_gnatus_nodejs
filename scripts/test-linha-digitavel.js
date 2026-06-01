// Valida o calculo de linha digitavel contra 2 boletos REAIS emitidos pelos
// proprios bancos (PDFs em docs/boleto-samples/). Se algum diff, falha com
// exit 1.

const { calcular } = require('../services/linhaDigitavel');

const CASOS = [
  {
    nome: 'Santander 085299/03 (PDF do banco)',
    input: {
      banco: '033', cedente: '3418790',
      nossoNumero: '0000000183660', carteira: '104',
      valor: 527.66, vencimento: '20260603'
    },
    esperado: {
      linhaDigitavel: '03399.34184 79000.000004 18366.001040 9 14660000052766',
      codigoBarras:   '03399146600000527669341879000000001836600104'
    }
  },
  {
    nome: 'Itau 092647/02 (PDF do banco)',
    input: {
      banco: '341', agencia: '0298', conta: '25776',
      nossoNumero: '09264702', carteira: '109',
      valor: 691.39, vencimento: '20260620'
    },
    esperado: {
      linhaDigitavel: '34191.09099 26470.210290 82577.670001 6 14830000069139',
      codigoBarras:   '34196148300000691391090926470210298257767000'
    }
  }
];

// Normaliza pra comparar tirando espaços/pontos
const norm = (s) => String(s).replace(/[\s.]/g, '');

let falhas = 0;
CASOS.forEach((c, i) => {
  console.log(`\n=== Caso ${i + 1}: ${c.nome} ===`);
  try {
    const r = calcular(c.input);
    const okLd = norm(r.linhaDigitavel) === norm(c.esperado.linhaDigitavel);
    const okCb = r.codigoBarras === c.esperado.codigoBarras;
    console.log(`  Esperado LD: ${c.esperado.linhaDigitavel}`);
    console.log(`  Obtido   LD: ${r.linhaDigitavel}             ${okLd ? '✓' : '✗ MISMATCH'}`);
    console.log(`  Esperado CB: ${c.esperado.codigoBarras}`);
    console.log(`  Obtido   CB: ${r.codigoBarras}     ${okCb ? '✓' : '✗ MISMATCH'}`);
    if (!okLd || !okCb) falhas++;
  } catch (e) {
    console.error(`  ERRO: ${e.message}`);
    falhas++;
  }
});

if (falhas) {
  console.error(`\n${falhas} caso(s) com diff — calculo nao bate com PDF oficial.`);
  process.exit(1);
}
console.log('\nTodos os casos OK — linha digitavel bate com os PDFs do banco.');

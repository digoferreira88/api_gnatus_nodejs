// Gera 2 PDFs de exemplo (Santander e Itau) com dados ficticios pra validar
// o layout do services/boletoPdf.js. Rode:
//   node scripts/test-boleto-pdf.js
// Saida: scripts/_out/boleto-santander.pdf + boleto-itau.pdf

const fs = require('fs');
const path = require('path');
const { gerarBoletoPdf, montarInstrucoes } = require('../services/boletoPdf');

const OUT_DIR = path.join(__dirname, '_out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const beneficiario = {
  nome: 'GNATUS PRODUTOS MEDICOS E ODONTOLOGICOS LTDA - EPP',
  cnpj: '09609356000100',
  endereco: 'AV DOS MACONS, 405 - JARDIM RAMOS - BARRETOS - SP - CEP 14783-167'
};

const pagador = {
  nome: 'TIAGO PIRES MENDES',
  cgc: '30087695000151',
  endereco: 'RUA OTACILIO DE SOUZA TELES, 51',
  bairro: 'TAMBORIL',
  municipio: 'SEABRA',
  uf: 'BA',
  cep: '46900000'
};

(async () => {
  // ---- Santander ----
  const santander = await gerarBoletoPdf({
    banco: '033',
    beneficiario, pagador,
    valor: 343.49,
    vencimento: '20260601',
    numeroDocumento: '08524403',
    dataDocumento: '20260303',
    nossoNumero: '0000000180173',
    agencia: '0820',
    conta: '3418790',
    carteira: 'PENH. ELETR',
    especieDoc: 'DM',
    linhaDigitavel: '03399.34184.79000.000004.18017.301047.5.14640000034349',
    codigoBarras: '03395146400000343490341847900000041801730104',
    instrucoes: montarInstrucoes({ jurosDia: 0.23, multaPct: 2.0, valor: 343.49, vencimento: '20260601' })
  });
  fs.writeFileSync(path.join(OUT_DIR, 'boleto-santander.pdf'), santander);
  console.log(`✓ Santander: ${santander.length} bytes -> scripts/_out/boleto-santander.pdf`);

  // ---- Itau ----
  const itau = await gerarBoletoPdf({
    banco: '341',
    beneficiario: { ...beneficiario, nome: 'GNATUS PROD MED E ODONT LTDA' },
    pagador: {
      nome: 'UNINTER EDUCACIONAL S/A', cgc: '002261854000157',
      endereco: 'RUA CLARA VENDRAMIN, 58', bairro: 'MOSSUNGUE',
      municipio: 'CURITIBA', uf: 'PR', cep: '81200170'
    },
    valor: 3996.19,
    vencimento: '20260618',
    numeroDocumento: '09277702',
    dataDocumento: '20260527',
    nossoNumero: '109/09277702-6',
    agencia: '0298',
    conta: '25776',
    carteira: '109',
    especieDoc: 'DMI',
    linhaDigitavel: '34191.09099 27770.260290 82577.670001 5 14810000399619',
    codigoBarras: '34195148100003996190910927770260298257767000',
    instrucoes: [
      'APOS 19/06/2026 COBRAR MORA DE R$ ...... 1,33 AO DIA',
      'CREDITO DADO EM GARANTIA AO BANCO ITAU S.A., PAGAR SOMENTE EM BANCO'
    ]
  });
  fs.writeFileSync(path.join(OUT_DIR, 'boleto-itau.pdf'), itau);
  console.log(`✓ Itau: ${itau.length} bytes -> scripts/_out/boleto-itau.pdf`);
})().catch(e => { console.error('ERRO:', e); process.exit(1); });

// services/portadorCessao.js — portadores de CESSÃO DE CRÉDITO (FIDC) que fazem
// cobrança registrada, mas NÃO têm coordenadas bancárias no SA6010 do Protheus.
//
// Contexto: nos portadores comuns (033 Santander, 341 Itaú), o SA6010 traz
// agência/conta e o boleto é emitido no próprio banco. Num FIDC a Gnatus CEDE o
// título ao fundo, e a cobrança é registrada no banco LIQUIDANTE, na conta do
// FUNDO — dados que não existem no Protheus (o SA6010 do 044 vem zerado:
// A6_AGENCIA='00000', A6_NUMCON='0000000000'). Por isso ficam aqui.
//
// ⚠️ DISTINÇÃO IMPORTANTE:
//   `portador`     = código do Protheus (E1_PORTADO) — ex.: '044'
//   `bancoBoleto`  = COMPE do banco liquidante — é o que vai no CÓDIGO DE BARRAS
//                    e na linha digitável — ex.: '237' (Bradesco)
// O boleto do Acreditar é um boleto Bradesco 237; o 044 nunca aparece no barcode.
//
// Validado contra o boleto oficial em docs/FIDIC/ (linha digitável reproduzida
// dígito a dígito: 23792.37205 90000.001579 65003.994707 3 17120000015459).
//
// Override por .env (sem precisar de deploy):
//   PORTADOR_044_AGENCIA / _CONTA / _CARTEIRA / _BANCO_BOLETO

const trim = (v) => String(v == null ? '' : v).trim();
const env = (k) => trim(process.env[k]);

const PORTADORES = {
  '044': {
    portador: '044',
    nome: 'Acreditar FIDC',
    bancoBoleto: '237',                 // Bradesco — banco liquidante (vai no barcode)
    agencia: '2372',                    // agência do FUNDO no Bradesco (02372-0)
    conta: '0039947',                   // conta do FUNDO (0039947-7), sem DV
    carteira: '09',
    especie: 'DM',
    beneficiarioFinal: {
      nome: 'ACREDITAR FUNDO I E D CREDITORIOS',
      cnpj: '29152636000130'
    },
    // Instruções obrigatórias no boleto (cessão) — conforme boleto oficial.
    instrucoes: [
      'ATENÇÃO: Título cedido à Acreditar FIDC.',
      'Quitação válida exclusivamente por este boleto.',
      'Não pague boletos emitidos por terceiros'
    ]
  },

  // Grupo BFC (25/09/2026). O Protheus ja tem o cadastro no mesmo padrao do 044:
  // SA6 'GRUPO BFC' e SEE carteira '001', ambos com ag/conta ZERADAS — o que basta
  // pro BORDERO. O Diego confirmou que a remessa usa o mesmo .REM do Bradesco,
  // entao o campo livre 237 e o parser do retorno ja servem.
  //
  // O BFC registra o titulo no Bradesco com nosso numero proprio (vem no .RET,
  // "Registrar pelo .RET"). A intranet gera a MESMA ficha que o fundo emite —
  // modelo em docs/financeiro/boleto bfc.pdf, titulo 1/091467/02, linha
  // digitavel conferida digito a digito (23792.96003 99911.123000
  // 29006.900004 9 16160000082397) — e dispara como os outros bancos
  // (decisao do usuario, 21/10/2026: a trava "o fundo ja envia" foi retirada).
  '699': {
    portador: '699',
    nome: 'Grupo BFC',
    bancoBoleto: '237',
    agencia: '2960',                    // do boleto do fundo: "2960/0069000-7"
    conta: '0069000',                   // codigo do beneficiario, sem DV
    contaDv: '7',
    carteira: '09',
    especie: 'DM',
    beneficiarioFinal: {                // quem cobra no boleto = o FUNDO
      nome: 'BFC FUNDO DE INVESTIMENTO EM DIREITOS CREDITÓRIOS',
      cnpj: '11507489000109'
    },
    instrucoes: [],                     // o boleto do fundo nao traz aviso de cessao
    // Regras de cobranca impressas pelo fundo. NAO vem da SE1: E1_MULTA e
    // E1_VALJUR estao zerados nos 516 titulos do 699. Inferidas do boleto
    // modelo (R$ 823,97 -> multa R$ 16,48 = 2%; juros R$ 3,30/dia = 0,4%/dia).
    // ⚠️ Confirmar com o fundo se mudarem ou se houver titulo com regra propria.
    regrasCobranca: { protestoDiasUteis: 3, multaPct: 2, jurosDiaPct: 0.4 },
    // Layout da ficha igual a do fundo.
    pdf: {
      localPagamento: 'Pagável preferencialmente na Rede Bradesco ou Bradesco Expresso.',
      codigoBeneficiario: '0069000-7',
      beneficiarioSemEndereco: true,
      labelBeneficiarioFinal: 'Sacador/Avalista',
      sacador: { nome: 'GNATUS PRODUTOS MEDICOS E ODONTOLOGICOS LTDA', cnpj: '09609356000100' },
      especieMoeda: 'R$',
      nossoNumeroBradesco: true,        // "09/99111230029-4"
      numeroDocumento: 'num7-parcela',  // "0091467-2"
      datasDaOcorrencia: true           // data documento e processamento = entrada confirmada (.RET)
    }
  }
};

// O boleto so pode ser gerado quando as coordenadas do fundo existem. Sem elas
// da pra fazer bordero (que usa a ag/conta do Protheus), mas nao boleto.
const boletoConfigurado = (p) => !!(p && trim(p.agencia) && trim(p.conta) && trim(p.carteira));

// Aplica overrides de .env por portador (ex.: PORTADOR_044_AGENCIA=1234).
function comOverrides(p) {
  const pref = `PORTADOR_${p.portador}_`;
  return {
    ...p,
    bancoBoleto: env(pref + 'BANCO_BOLETO') || p.bancoBoleto,
    agencia: env(pref + 'AGENCIA') || p.agencia,
    conta: env(pref + 'CONTA') || p.conta,
    carteira: env(pref + 'CARTEIRA') || p.carteira
  };
}

// Config do portador de cessão, ou null se não for um deles.
function get(portador) {
  const p = PORTADORES[trim(portador)];
  return p ? comOverrides(p) : null;
}

/**
 * Resolve os dados bancários EFETIVOS DO BOLETO a partir do portador do lote.
 *
 * Portador comum (033/341/...) -> devolve o que veio (SA6010), inalterado.
 * Portador de CESSÃO (044)     -> troca pelo BANCO LIQUIDANTE + conta do FUNDO,
 *                                 porque o lote guarda a ag/conta ZERADA do
 *                                 Protheus (que serve pro borderô, não pro boleto).
 *
 * Use SEMPRE isto antes de calcular linha digitável / gerar PDF.
 * @returns {{banco, agencia, conta, carteira?, especie?, beneficiarioFinal?, instrucoes?, cessao, portador?}}
 */
function dadosBoleto({ banco, agencia, conta } = {}) {
  const p = get(banco);
  if (!p) return { banco: trim(banco), agencia: trim(agencia), conta: trim(conta), cessao: false };
  // Portador de cessao sem as coordenadas do fundo: sinaliza pendente em vez de
  // devolver campo vazio, que viraria um codigo de barras invalido silencioso.
  if (!boletoConfigurado(p)) {
    return {
      banco: p.bancoBoleto, agencia: '', conta: '', carteira: '',
      cessao: true, portador: p.portador, boletoPendente: true,
      motivo: `O boleto do portador ${p.portador} (${p.nome}) ainda não está configurado: faltam agência, conta e carteira do fundo no banco ${p.bancoBoleto}. O borderô funciona; a emissão de boleto não.`
    };
  }
  return {
    banco: p.bancoBoleto,
    agencia: p.agencia,
    conta: p.conta,
    carteira: p.carteira,
    especie: p.especie,
    beneficiarioFinal: p.beneficiarioFinal,
    instrucoes: p.instrucoes,
    regrasCobranca: p.regrasCobranca || null,
    pdf: p.pdf || null,
    cessao: true,
    portador: p.portador
  };
}

const ehCessao = (portador) => !!PORTADORES[trim(portador)];
const codigos = () => Object.keys(PORTADORES);
const listar = () => codigos().map((c) => get(c));

module.exports = { get, dadosBoleto, ehCessao, codigos, listar, boletoConfigurado };

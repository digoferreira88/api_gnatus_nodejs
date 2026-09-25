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
  // ⚠️ BOLETO AINDA NAO CONFIGURADO: faltam agencia/conta/carteira do fundo no
  // Bradesco e o CNPJ do beneficiario. Ficam VAZIOS de proposito — `dadosBoleto`
  // devolve `boletoPendente` e quem gera boleto/linha recusa, em vez de emitir
  // com coordenada inventada, que seria um boleto impagavel.
  '699': {
    portador: '699',
    nome: 'Grupo BFC',
    bancoBoleto: '237',
    agencia: '',
    conta: '',
    carteira: '',
    especie: 'DM',
    beneficiarioFinal: null,
    instrucoes: [
      'ATENÇÃO: Título cedido ao Grupo BFC.',
      'Quitação válida exclusivamente por este boleto.',
      'Não pague boletos emitidos por terceiros'
    ]
  }
};

// O boleto so pode ser emitido quando as coordenadas do fundo existem. Sem elas
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
    cessao: true,
    portador: p.portador
  };
}

const ehCessao = (portador) => !!PORTADORES[trim(portador)];
const codigos = () => Object.keys(PORTADORES);
const listar = () => codigos().map((c) => get(c));

module.exports = { get, dadosBoleto, ehCessao, codigos, listar, boletoConfigurado };

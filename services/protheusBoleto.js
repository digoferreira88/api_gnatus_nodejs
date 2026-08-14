// Linha digitavel / codigo de barras de um boleto JA registrado.
//
// Historia: ate 2026-05-29 chamavamos o GET /Cobranca/boleto-linha do Diego
// pra esses dois campos. Descobrimos comparando contra PDFs OFICIAIS do banco
// (Santander 085299/03 e Itau 092647/02) que o calculo do Diego no AdvPL
// estava errado: NN deslocado 1 posicao + carteira fixa 101 (banco usa 104).
// Cliente que copiasse a linha digitavel da intranet recebia "linha invalida"
// no app do banco. Movido pra calculo LOCAL via services/linhaDigitavel.
//
// A funcao mantem a mesma interface externa pra nao quebrar os callers; o
// path Diego ficou como fallback pra bancos que nao sabemos calcular local.
// Veja docs/boleto-samples/ pros 2 PDFs validados.

const LinhaDigitavel = require('./linhaDigitavel');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

// Convenio + carteira padrao por banco (cobranca registrada Gnatus).
// 033 Santander: cedente 3418790, carteira 104 (Penhor Eletronico com registro).
// 341 Itau: cedente vem da conta corrente (sem DV), carteira 109.
// 237 Bradesco: cedente = agencia+conta (vao direto no campo livre), carteira 09
// — usado na cessao ao Acreditar FIDC (ver services/portadorCessao.js).
const CONVENIO_POR_BANCO = { '033': '3418790' };
const CARTEIRA_POR_BANCO = { '033': '104', '341': '109', '237': '09' };

/**
 * Calcula a linha digitavel + codigo de barras de um titulo registrado.
 *
 * @param {object} opts
 * @param {string} opts.banco        codigo Febraban (3 digitos: '033','341'...)
 * @param {string} opts.agencia      A6_AGENCIA (4 digitos, com zero pad)
 * @param {string} opts.conta        A6_NUMCON (5 digitos Itau / 7 Santander)
 * @param {string} opts.nossoNumero  do banco (8 Itau / 13 Santander, com zero pad)
 * @param {number} opts.valor        em R$ (ex.: 527.66)
 * @param {string} opts.vencimento   YYYYMMDD
 * @param {string} [opts.carteira]   override do default por banco
 * @returns {{ok, httpStatus, body}}
 *   body em sucesso: { ok:true, linha_digitavel, codigo_barras, nosso_numero, banco,
 *                       agencia, conta, carteira, vencimento, valor, fonte:'intranet' }
 *
 * Compat: ainda aceita os campos antigos {filial, prefixo, numero, parcela,
 * cliente, loja, tipo} — sao ignorados (eram so pra Diego identificar o
 * titulo). Hoje, quem chama precisa passar os dados base ja lidos do PG.
 */
async function linhaDigitavel(opts) {
  if (!opts) {
    return { ok: false, httpStatus: 400, body: { ok: false, codigo_erro: 'PARAMS', mensagem: 'opts obrigatorio.' } };
  }
  const banco = trim(opts.banco);
  const nn = trim(opts.nossoNumero);
  const venc = trim(opts.vencimento);
  const valor = N(opts.valor);

  // Validacoes basicas — sem esses campos nao da pra calcular
  if (!banco || !nn || !venc || !valor) {
    return {
      ok: false, httpStatus: 400,
      body: { ok: false, codigo_erro: 'PARAMS', mensagem: `Faltam dados base: banco=${banco} nn=${nn} venc=${venc} valor=${valor}` }
    };
  }

  // Cedente: pra Santander vem do convenio (CONVENIO_POR_BANCO); pra Itau eh
  // a conta corrente sem DV (que ja vem em opts.conta).
  let cedente = '';
  if (banco === '033') cedente = trim(opts.cedente) || CONVENIO_POR_BANCO['033'];
  else if (banco === '341') cedente = trim(opts.conta);

  const carteira = trim(opts.carteira) || CARTEIRA_POR_BANCO[banco] || '';

  try {
    const r = LinhaDigitavel.calcular({
      banco,
      agencia: trim(opts.agencia),
      conta: trim(opts.conta),
      cedente,
      nossoNumero: nn,
      carteira,
      valor,
      vencimento: venc
    });
    return {
      ok: true, httpStatus: 200,
      body: {
        ok: true,
        linha_digitavel: r.linhaDigitavel,
        codigo_barras: r.codigoBarras,
        nosso_numero: nn.replace(/\D/g, ''),
        banco, agencia: trim(opts.agencia), conta: trim(opts.conta),
        carteira, vencimento: venc, valor,
        fonte: 'intranet'
      }
    };
  } catch (err) {
    return {
      ok: false, httpStatus: 422,
      body: {
        ok: false,
        codigo_erro: err.code || 'CALCULO',
        mensagem: err.message,
        banco
      }
    };
  }
}

module.exports = { linhaDigitavel, CONVENIO_POR_BANCO, CARTEIRA_POR_BANCO };

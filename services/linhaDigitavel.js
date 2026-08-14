// Calcula a LINHA DIGITAVEL + CODIGO DE BARRAS de um boleto a partir dos
// dados base (NN, agencia, conta, cedente, carteira, valor, vencimento).
// Algoritmo Febraban padrao (Mod 10 / Mod 11 / fator de vencimento) com
// campo livre especifico por banco.
//
// Substitui o GET /Cobranca/boleto-linha do Diego — o calculo no AdvPL
// estava devolvendo NN deslocado e carteira errada (descoberto 2026-05-29
// comparando contra PDFs oficiais do Santander e Itau).
//
// Bancos suportados: 033 Santander (carteira 104) + 341 Itau (carteira 109)
// + 237 Bradesco (carteira 09 — usado na cessao ao Acreditar FIDC).
// Outros bancos: lancar erro (`BANCO_NAO_SUPORTADO`) — operador continua
// usando Diego ate adicionarmos a carteira aqui.
//
// Uso:
//   const { linhaDigitavel, codigoBarras } = calcular({
//     banco: '033', agencia: '0820', conta: '3418790', nossoNumero: '0000000183660',
//     carteira: '104', valor: 527.66, vencimento: '20260603'
//   });
//
// Os campos NN/agencia/conta sao normalizados (apenas digitos). Valor pode
// vir como number ou string. Vencimento aceita 'YYYYMMDD' ou 'YYYY-MM-DD'
// ou Date.

const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const pad = (v, n, c = '0') => onlyDigits(v).padStart(n, c).slice(-n);

// Fator de vencimento Febraban — apos o overflow 9999 em fev/2025, a base foi
// realocada pra 22/02/2025 com fator 1000.
const FATOR_BASE = Date.UTC(2025, 1, 22);   // 22/02/2025 (mes 0-indexed)
const MS_DIA = 86400000;

function fatorVencimento(venc) {
  let dt;
  if (venc instanceof Date) {
    dt = Date.UTC(venc.getUTCFullYear(), venc.getUTCMonth(), venc.getUTCDate());
  } else {
    const s = String(venc || '').replace(/\D/g, '');
    if (s.length !== 8) throw new Error(`vencimento invalido: ${venc}`);
    dt = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  }
  const dias = Math.round((dt - FATOR_BASE) / MS_DIA) + 1000;
  if (dias < 1000 || dias > 9999) throw new Error(`fator de vencimento fora do range (${dias})`);
  return String(dias).padStart(4, '0');
}

// Mod 10 — DV de cada campo da linha digitavel (10 chars) e do DAC Itau.
// Pesos 2,1,2,1,... DA DIREITA PRA ESQUERDA. Soma dos digitos (>= 10 vira
// soma dos dois). DV = (10 - soma%10) % 10.
function mod10(numStr) {
  const s = onlyDigits(numStr);
  let soma = 0, peso = 2;
  for (let i = s.length - 1; i >= 0; i--) {
    const p = parseInt(s[i], 10) * peso;
    soma += p >= 10 ? Math.floor(p / 10) + (p % 10) : p;
    peso = peso === 2 ? 1 : 2;
  }
  return (10 - (soma % 10)) % 10;
}

// Mod 11 — DV geral do codigo de barras. Pesos 2..9 ciclicos DA DIREITA PRA
// ESQUERDA. resto = soma%11. DV = 11-resto. Se DV == 0, 10, 11 → 1 (Febraban).
function mod11(numStr) {
  const s = onlyDigits(numStr);
  let soma = 0, peso = 2;
  for (let i = s.length - 1; i >= 0; i--) {
    soma += parseInt(s[i], 10) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const dv = 11 - (soma % 11);
  return (dv === 0 || dv > 9) ? 1 : dv;
}

// Campo livre Santander 033 — layout cobranca registrada:
//   1     Fixo "9" (cobranca com registro)
//   2-8   Cedente (cod beneficiario, 7 digitos)
//   9-21  Nosso Numero (13 digitos)
//   22    IOF (0 para empresas comuns)
//   23-25 Carteira (3 digitos: 101 simples, 104 com registro/penhor, etc.)
function campoLivreSantander({ cedente, nossoNumero, carteira }) {
  const c = pad(cedente, 7);
  const nn = pad(nossoNumero, 13);
  const cart = pad(carteira || '104', 3);
  return '9' + c + nn + '0' + cart;
}

// Campo livre Itau 341 — layout cobranca registrada:
//   1-3   Carteira (3 digitos: 109, 175, 107, etc.)
//   4-11  Nosso Numero (8 digitos, SEM o DAC)
//   12    DAC NN (mod10 sobre agencia+conta+carteira+NN)
//   13-16 Agencia (4 digitos)
//   17-21 Conta (5 digitos, SEM DV)
//   22    DAC Conta (mod10 sobre agencia+conta)
//   23-25 Zeros "000"
function campoLivreItau({ agencia, conta, nossoNumero, carteira }) {
  const ag = pad(agencia, 4);
  const cc = pad(conta, 5);
  const cart = pad(carteira || '109', 3);
  const nn = pad(nossoNumero, 8);
  const dacNN = mod10(ag + cc + cart + nn);
  const dacConta = mod10(ag + cc);
  return cart + nn + dacNN + ag + cc + dacConta + '000';
}

// Campo livre Bradesco 237 — layout cobranca registrada:
//   1-4    Agencia (4 digitos, sem DV)
//   5-6    Carteira (2 digitos: 09 cobranca simples com registro, 06, 19...)
//   7-17   Nosso Numero (11 digitos, SEM o DV)
//   18-24  Conta (7 digitos, sem DV)
//   25     Zero fixo
// ✅ Validado digito a digito contra o boleto OFICIAL do Acreditar FIDC
//    (docs/FIDIC/*.pdf): ag 2372 + cart 09 + NN 00000015765 + cc 0039947 + 0
//    => linha 23792.37205 90000.001579 65003.994707 3 17120000015459.
function campoLivreBradesco({ agencia, conta, nossoNumero, carteira }) {
  return pad(agencia, 4) + pad(carteira || '09', 2) + pad(nossoNumero, 11) + pad(conta, 7) + '0';
}

// Monta o codigo de barras (44) a partir do "sem DV" (43) e DV geral.
// Pos 1-4 = ID+Moeda, pos 5 = DV, pos 6-19 = fator+valor, pos 20-44 = livre.
function montarCodigoBarras({ banco, fator, valor, campoLivre }) {
  const moeda = '9';
  const valStr = String(Math.round(Number(valor) * 100)).padStart(10, '0');
  if (valStr.length > 10) throw new Error(`valor muito alto: ${valor}`);
  const semDv = pad(banco, 3) + moeda + fator + valStr + campoLivre;
  if (semDv.length !== 43) throw new Error(`codigo de barras sem DV tem ${semDv.length} chars (esperado 43)`);
  const dv = mod11(semDv);
  return semDv.slice(0, 4) + dv + semDv.slice(4);
}

// Codigo de barras (44) → linha digitavel (47) com DVs intercalados.
// Posicoes do barras pra cada campo:
//   Campo 1: barras[0:4] + barras[19:24]  (ID+Moeda+5 primeiros livres)
//   Campo 2: barras[24:34]                 (proximos 10 livres)
//   Campo 3: barras[34:44]                 (ultimos 10 livres)
//   Campo 4: barras[4]                     (DV geral)
//   Campo 5: barras[5:19]                  (fator + valor)
function montarLinhaDigitavel(cb) {
  if (cb.length !== 44) throw new Error(`codigoBarras tem ${cb.length} chars (esperado 44)`);
  const c1 = cb.slice(0, 4) + cb.slice(19, 24);     // 9 chars (sem DV1)
  const c2 = cb.slice(24, 34);                       // 10 chars
  const c3 = cb.slice(34, 44);                       // 10 chars
  const dv1 = mod10(c1);
  const dv2 = mod10(c2);
  const dv3 = mod10(c3);
  const dvg = cb[4];
  const fv = cb.slice(5, 19);
  const c1f = c1 + String(dv1);
  const c2f = c2 + String(dv2);
  const c3f = c3 + String(dv3);
  // Formato Santander/Itau de exibicao: AAAAA.BBBBB CCCCC.DDDDDD EEEEE.FFFFFF G HHHHHHHHHHHHHH
  return `${c1f.slice(0, 5)}.${c1f.slice(5)} ${c2f.slice(0, 5)}.${c2f.slice(5)} ${c3f.slice(0, 5)}.${c3f.slice(5)} ${dvg} ${fv}`;
}

// ============== API publica ==============
function calcular(opts) {
  if (!opts) throw new Error('opts obrigatorio');
  const banco = pad(opts.banco, 3);
  const fator = fatorVencimento(opts.vencimento);

  let campoLivre;
  switch (banco) {
    case '033':
      campoLivre = campoLivreSantander(opts);
      break;
    case '341':
      campoLivre = campoLivreItau(opts);
      break;
    case '237':
      campoLivre = campoLivreBradesco(opts);
      break;
    default:
      const err = new Error(`Banco ${banco} ainda nao suportado (BANCO_NAO_SUPORTADO).`);
      err.code = 'BANCO_NAO_SUPORTADO';
      throw err;
  }

  if (campoLivre.length !== 25) {
    throw new Error(`campo livre tem ${campoLivre.length} chars (esperado 25): ${campoLivre}`);
  }

  const codigoBarras = montarCodigoBarras({ banco, fator, valor: opts.valor, campoLivre });
  const linhaDigitavel = montarLinhaDigitavel(codigoBarras);
  return { linhaDigitavel, codigoBarras };
}

module.exports = { calcular, fatorVencimento, mod10, mod11 };

// Filtra de um retorno CNAB400 as linhas-detalhe de titulos JA BAIXADOS
// (E1_STATUS='B'). Essas linhas sao no-op (titulo ja liquidado) e fazem o
// endpoint importar-retorno do Diego estourar HTTP 500 — exception AdvPL nao
// tratada no path de liquidacao (vide docs/spec-diego-retorno-santander-500).
//
// Mantem TODAS as demais linhas (registros + baixas de titulos ainda abertos),
// entao nenhuma baixa/registro real e' perdido — so removemos o que ja esta
// baixado no Protheus. Aplicado SO ao Santander (033); Itau (341) funciona e
// nao e' tocado.
//
// Renumera a sequencia (ultimos 6 digitos de cada linha de largura fixa) pra o
// arquivo seguir bem-formado. Os contadores/totais internos do trailer (tipo 9)
// NAO sao recalculados: o parser do Diego (dry-run) tolera; o import real via
// FINA205 esta sob validacao.

// ===================== SANTANDER 033 (CNAB400 retorno) =====================
// Layout POSICIONAL. Posicoes 0-indexed:
//
//   [37..62)   Uso da empresa (25) = prefixo(3) + numero(9) + parcela(2) + tipo(3)
//              ex.: "PED094610   04DP " · "FT OMN16748806BOL"
//   [62..70)   Nosso Numero (8) atribuido pelo banco
//   [108..110) Codigo de ocorrencia (02=entrada confirmada, 06=liquidacao...)
//   [110..116) Data da ocorrencia DDMMAA
//   [116..126) Seu numero (10) — trunca o numero em 6 posicoes; nao e' chave.
//              Desde a COBR001-R43 o Diego tambem cruza o 033 pelo uso da empresa.
//   [152..165) Valor do titulo (13, 2 decimais implicitas)
//
// 🔴 Ate 09/10/2026 isto era uma regex que exigia numero de 6 DIGITOS e especie
// DP|NF. O financeiro passou a gerar titulos alfanumericos (borderô 418812:
// prefixo FT, numero OMN167488, tipo BOL) e essas linhas sumiam do parse em
// silencio: nao registravam pelo .RET nem passavam pelo filtro de ja-baixados.
// O uso da empresa volta do banco INTEIRO, entao a chave sai dele.
const SA = { USO: [37, 62], NN: [62, 70], OCOR: [108, 110], DATA: [110, 116], SEU: [116, 126], VALOR: [152, 165] };

// Quebra o "uso da empresa" (25) em prefixo/numero/parcela/especie. Mesmo
// recorte no Santander e no Bradesco.
function partirUso(uso) {
  return {
    prefixo: uso.slice(0, 3).trim(),
    numero: uso.slice(3, 12).trim(),
    parcela: uso.slice(12, 14).trim(),
    especie: uso.slice(14, 17).trim()
  };
}

// Extrai (prefixo, numero, parcela) de uma linha-detalhe Santander; null se a
// linha nao for detalhe ou estiver fora do layout.
function chaveLinha(l) {
  const s = String(l || '');
  if (s[0] !== '1' || s.length < SA.SEU[1]) return null;
  if (!/^\d{8}$/.test(s.slice(SA.NN[0], SA.NN[1]))) return null;
  const u = partirUso(s.slice(SA.USO[0], SA.USO[1]));
  if (!u.numero) return null;
  return { prefixo: u.prefixo, numero: u.numero, parcela: u.parcela };
}

// Parse completo das linhas-detalhe (tipo '1'): inclui ocorrencia e nosso numero.
// Retorna [{prefixo, numero, parcela, especie, nossoNumero(8 dig), ocorrencia(2 dig), seuNumero, valor}].
function parseDetalhes(conteudo) {
  const linhas = String(conteudo || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    const c = chaveLinha(l);
    if (!c) continue;
    const ocor = l.slice(SA.OCOR[0], SA.OCOR[1]);
    if (!/^\d{2}$/.test(ocor)) continue;
    out.push({
      linha: i + 1,
      ...partirUso(l.slice(SA.USO[0], SA.USO[1])),
      nossoNumero: l.slice(SA.NN[0], SA.NN[1]),   // 8 digitos (ex.: '00191620')
      ocorrencia: ocor,                           // 02=entrada confirmada, 03=rejeitada, 06=liquidacao...
      dataOcorrencia: l.slice(SA.DATA[0], SA.DATA[1]),
      seuNumero: l.slice(SA.SEU[0], SA.SEU[1]).trim(),
      valor: Number(l.slice(SA.VALOR[0], SA.VALOR[1])) / 100
    });
  }
  return out;
}

/**
 * Remonta o arquivo so com as linhas-detalhe que `manter(linha)` aprovar,
 * preservando header e trailer e renumerando a sequencia (ultimos 6 digitos)
 * quando a largura e' fixa. Os totais do trailer NAO sao recalculados — o
 * parser do Diego tolera (mesma premissa do filtro de ja-baixados).
 * Sem nenhuma linha removida devolve o conteudo original, byte a byte.
 */
function remontar(conteudo, manter) {
  const eol = String(conteudo).includes('\r\n') ? '\r\n' : '\n';
  const linhas = String(conteudo).split(/\r?\n/);
  const temVaziaFinal = linhas.length && linhas[linhas.length - 1] === '';
  const corpo = temVaziaFinal ? linhas.slice(0, -1) : linhas;
  if (corpo.length < 3) return { conteudo, mantidos: Math.max(corpo.length - 2, 0), total: Math.max(corpo.length - 2, 0) };

  const header = corpo[0];
  const trailer = corpo[corpo.length - 1];
  const detalhes = corpo.slice(1, -1);
  const mantidos = detalhes.filter(manter);
  if (mantidos.length === detalhes.length) {
    return { conteudo, mantidos: detalhes.length, total: detalhes.length };
  }

  const L = header.length;
  const larguraUnica = corpo.every(l => l.length === L) && L > 6;
  const renum = (l, n) => larguraUnica ? (l.slice(0, L - 6) + String(n).padStart(6, '0')) : l;
  let seq = 1;
  const out = [renum(header, seq++), ...mantidos.map(l => renum(l, seq++)), renum(trailer, seq)];
  return { conteudo: out.join(eol) + eol, mantidos: mantidos.length, total: detalhes.length };
}

// ===================== BRADESCO 237 (CNAB400 retorno) =====================
// Layout POSICIONAL (mais robusto que regex). Posicoes 0-indexed, validadas
// digito a digito contra o retorno REAL do Acreditar FIDC (docs/FIDIC/
// RETORNO_FIDC.RET) usando os nossos numeros do .REM como gabarito:
//
//   [37..62)  Uso da empresa (25) = prefixo(3) + numero(9) + parcela(2) + especie(2)
//             ex.: "PED090988   12DP" -> PED / 090988 / 12 / DP  (bate com a SE1)
//   [70..81)  Nosso Numero (11, SEM DV)   ex.: "00000015761"
//   [81]      DV do Nosso Numero          ex.: "1"  (pode ser 'P' no Bradesco)
//   [108..110) Codigo de ocorrencia (2)   ex.: "02" = entrada confirmada
//   [110..116) Data da ocorrencia DDMMAA
//   [152..165) Valor do titulo (13, 2 decimais implicitas)
//
// ⚠️ O DV do Bradesco pode ser a letra 'P' (quando o resto do mod11 da 10), por
// isso `dvNossoNumero` e' string e o NN cru NAO deve ser tratado como numero.
const BR = { USO: [37, 62], NN: [70, 81], DV: 81, OCOR: [108, 110], DATA: [110, 116], VALOR: [152, 165] };

function parseDetalhesBradesco(conteudo) {
  const linhas = String(conteudo || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    if (!l || l[0] !== '1' || l.length < 170) continue;      // so detalhe de largura plausivel
    const uso = l.slice(BR.USO[0], BR.USO[1]);
    const nn = l.slice(BR.NN[0], BR.NN[1]).trim();
    const ocor = l.slice(BR.OCOR[0], BR.OCOR[1]).trim();
    if (!/^\d+$/.test(nn) || !/^\d{2}$/.test(ocor)) continue;  // linha fora do layout -> ignora
    out.push({
      linha: i + 1,
      ...partirUso(uso),
      nossoNumero: nn,                                        // 11 digitos, sem DV
      dvNossoNumero: l[BR.DV],                                // pode ser digito ou 'P'
      ocorrencia: ocor,                                       // 02=entrada confirmada, 06=liquidado...
      dataOcorrencia: l.slice(BR.DATA[0], BR.DATA[1]),        // DDMMAA
      valor: Number(l.slice(BR.VALOR[0], BR.VALOR[1])) / 100
    });
  }
  return out;
}

// Despacha o parser certo pelo banco. '237' = posicional Bradesco; demais
// (033 Santander) seguem no parser por regex.
function parseDetalhesPorBanco(conteudo, banco) {
  return String(banco || '').trim() === '237'
    ? parseDetalhesBradesco(conteudo)
    : parseDetalhes(conteudo);
}

// ===================== CONTA POR LINHA (multi-carteira) =====================
// No Santander o bloco 18-37 da linha-detalhe e' agencia(4) + conta do
// CONVENIO(8) + conta do TITULO(8). Um mesmo arquivo traz titulos de carteiras
// diferentes — confirmado nos retornos de 01/06, 15/09 e 21/09/2026, todos
// misturando 13000208 e 29000258.
//
// 🔴 Ignorar isso custou caro: na baixa de 21/09 a intranet mandou UMA conta
// para o arquivo inteiro e 28 movimentos (R$ 64.025,26) foram gravados na conta
// errada, quebrando a conciliacao bancaria. Dai esta divisao.
//
// Itau (341) NAO mistura: conta unica no arquivo (posicoes 22-29). Bancos fora
// do mapa devolvem uma parte so, com o comportamento de antes.
const CONTA_POR_LINHA = { '033': [30, 37] };

/** Conta do titulo na linha-detalhe; '' quando o banco nao tem conta por linha. */
function contaDaLinha(linha, banco) {
  const faixa = CONTA_POR_LINHA[String(banco || '').trim()];
  if (!faixa) return '';
  const v = String(linha || '').slice(faixa[0] - 1, faixa[1]).trim();
  return /^\d{1,8}$/.test(v) ? v : '';
}

/** As contas distintas presentes nas linhas-detalhe, em ordem de aparicao. */
function contasDoArquivo(conteudo, banco) {
  const out = [];
  for (const l of String(conteudo || '').split(/\r?\n/)) {
    if (!l || l[0] !== '1') continue;
    const c = contaDaLinha(l, banco);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Divide o .RET por conta do titulo. Cada parte leva o MESMO header e trailer
 * e a sequencia renumerada, igual ao que o filtro de ja-baixados ja fazia.
 *
 * Devolve [{ conta, conteudo, linhas }]. Uma unica parte (conta '') quando o
 * banco nao tem conta por linha ou quando o arquivo so tem uma.
 */
function dividirPorConta(conteudo, banco) {
  const contas = contasDoArquivo(conteudo, banco);
  if (contas.length <= 1) {
    return [{ conta: contas[0] || '', conteudo, linhas: null }];
  }

  const eol = String(conteudo).includes('\r\n') ? '\r\n' : '\n';
  const linhas = String(conteudo).split(/\r?\n/);
  const temVaziaFinal = linhas.length && linhas[linhas.length - 1] === '';
  const corpo = temVaziaFinal ? linhas.slice(0, -1) : linhas;
  if (corpo.length < 3) return [{ conta: contas[0] || '', conteudo, linhas: null }];

  const header = corpo[0];
  const trailer = corpo[corpo.length - 1];
  const detalhes = corpo.slice(1, -1);
  const L = header.length;
  const larguraUnica = corpo.every(l => l.length === L) && L > 6;
  const renum = (l, n) => larguraUnica ? (l.slice(0, L - 6) + String(n).padStart(6, '0')) : l;

  return contas.map(conta => {
    // Linha que nao parseia a conta fica FORA das partes, de proposito: melhor
    // perder uma linha ilegivel do que manda-la para a carteira errada.
    const meus = detalhes.filter(l => contaDaLinha(l, banco) === conta);
    let seq = 1;
    const out = [renum(header, seq++), ...meus.map(l => renum(l, seq++)), renum(trailer, seq)];
    return { conta, conteudo: out.join(eol) + eol, linhas: meus.length };
  });
}

// Lista as chaves de todas as linhas-detalhe (tipo '1') de um conteudo CNAB.
function extrairChaves(conteudo) {
  const linhas = String(conteudo || '').split(/\r?\n/);
  const out = [];
  for (let i = 1; i < linhas.length - 1; i++) {   // pula header e trailer
    const l = linhas[i];
    if (!l || l[0] !== '1') continue;
    const c = chaveLinha(l);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Remove as linhas-detalhe cujos titulos estao no `baixadosSet`.
 * @param {string} conteudo    texto do .RET (latin1)
 * @param {Set<string>} baixadosSet  chaves 'prefixo|numero|parcela' ja baixadas
 * @returns {{conteudo, removidos:[{prefixo,numero,parcela}], mantidos:number, total:number}}
 */
function filtrarBaixados(conteudo, baixadosSet) {
  const removidos = [];
  const r = remontar(conteudo, (l) => {
    const c = chaveLinha(l);
    if (!c) return true;                                   // nao parseou -> mantem (seguro)
    if (baixadosSet.has(`${c.prefixo}|${c.numero}|${c.parcela}`)) { removidos.push(c); return false; }
    return true;
  });
  return { conteudo: r.conteudo, removidos, mantidos: r.mantidos, total: r.total };
}

module.exports = {
  filtrarBaixados, extrairChaves, chaveLinha,
  parseDetalhes, parseDetalhesBradesco, parseDetalhesPorBanco,
  contaDaLinha, contasDoArquivo, dividirPorConta
};

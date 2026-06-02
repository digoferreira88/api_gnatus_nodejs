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

// Bloco prefixo(3) + numero(6) + 3 espacos + parcela(2 ou 2 espacos) + (DP|NF)
const RX_CHAVE = /([A-Z0-9 ]{3})(\d{6})   (\d{2}| {2})(DP|NF)/;

// Linha completa Santander CNAB400 (retorno): apos a especie (DP|NF) vem
//   9 espacos + nosso_numero(8 dig) + ... gap ... + ocorrencia(3 dig: 1 sub +
//   2 cod) + data(6). Validado contra PDFs do banco (088318/02 -> 0000000191620,
//   091811/04 -> 0000000191612) em 2026-06.
const RX_DETALHE = /([A-Z0-9 ]{3})(\d{6})   (\d{2}| {2})(DP|NF) {9}(\d{8})\s+\d(\d{2})\d{6}/;

// Extrai (prefixo, numero, parcela) de uma linha-detalhe; null se nao casar.
function chaveLinha(l) {
  const m = String(l || '').match(RX_CHAVE);
  if (!m) return null;
  return { prefixo: m[1].trim(), numero: m[2], parcela: m[3].trim() };
}

// Parse completo das linhas-detalhe (tipo '1'): inclui ocorrencia e nosso numero.
// Retorna [{prefixo, numero, parcela, especie, nossoNumero(8 dig), ocorrencia(2 dig)}].
function parseDetalhes(conteudo) {
  const linhas = String(conteudo || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    if (!l || l[0] !== '1') continue;
    const m = l.match(RX_DETALHE);
    if (!m) continue;
    out.push({
      linha: i + 1,
      prefixo: m[1].trim(),
      numero: m[2],
      parcela: m[3].trim(),
      especie: m[4],
      nossoNumero: m[5],          // 8 digitos (ex.: '00191620')
      ocorrencia: m[6]            // 2 digitos (02=entrada confirmada, 03=rejeitada, 06=liquidacao...)
    });
  }
  return out;
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
  const eol = String(conteudo).includes('\r\n') ? '\r\n' : '\n';
  const linhas = String(conteudo).split(/\r?\n/);
  const temVaziaFinal = linhas.length && linhas[linhas.length - 1] === '';
  const corpo = temVaziaFinal ? linhas.slice(0, -1) : linhas;
  if (corpo.length < 3) return { conteudo, removidos: [], mantidos: corpo.length, total: corpo.length };

  const header = corpo[0];
  const trailer = corpo[corpo.length - 1];
  const detalhes = corpo.slice(1, -1);
  const L = header.length;

  const removidos = [];
  const mantidos = detalhes.filter(l => {
    const c = chaveLinha(l);
    if (!c) return true;                                   // nao parseou -> mantem (seguro)
    if (baixadosSet.has(`${c.prefixo}|${c.numero}|${c.parcela}`)) { removidos.push(c); return false; }
    return true;
  });

  if (!removidos.length) {
    return { conteudo, removidos: [], mantidos: detalhes.length, total: detalhes.length };
  }

  // Renumera a sequencia (ultimos 6 digitos) so se largura fixa consistente.
  const larguraUnica = corpo.every(l => l.length === L) && L > 6;
  const renum = (l, n) => larguraUnica ? (l.slice(0, L - 6) + String(n).padStart(6, '0')) : l;

  let seq = 1;
  const out = [renum(header, seq++), ...mantidos.map(l => renum(l, seq++)), renum(trailer, seq)];
  return { conteudo: out.join(eol) + eol, removidos, mantidos: mantidos.length, total: detalhes.length };
}

module.exports = { filtrarBaixados, extrairChaves, chaveLinha, parseDetalhes };

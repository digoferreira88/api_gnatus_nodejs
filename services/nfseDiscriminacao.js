// services/nfseDiscriminacao.js — monta a descrição do serviço da NFS-e (xDescServ) no
// padrão do fiscal (planilha docs/fiscal/CODIGOS SERVIÇOS.xlsx, abas "CÓD. DE SERVIÇOS"
// e "MSG NFS", 05/11/2026). Três casos:
//   1) produto com mensagem fixa (campo `mensagem` da de-para): usa a mensagem e troca o
//      "REF. PEDIDO ...." pelo número do pedido;
//   2) instalação ("SERVIÇO DE INSTALAÇÃO ..."): "SERVIÇO DE INSTALAÇÃO DE CONSULTÓRIOS /
//      MOCHO / REFLETOR ... - REF PEDIDO: <nº>", com os equipamentos em nome curto;
//   3) demais serviços: nomes juntados com " + " e " - REF PEDIDO: <nº>" (ex.: "VISITA
//      TECNICA (SERVIÇO) + SERVIÇO DE DESLOCAMENTO KM RODADO - REF PEDIDO: 123").
// NFSE_DESCRICAO_PADRAO=0 volta ao formato antigo (nome do produto + quantidade + valor).

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const MAX = 1400;   // xDescServ aceita 2000; sobra espaço para a observação digitada na emissão

let _msgs = null;
function mensagens() {
  if (_msgs) return _msgs;
  _msgs = {};
  try {
    for (const r of require('../data/nfse-depara-servicos.json')) {
      if (trim(r.mensagem)) _msgs[trim(r.codigo)] = trim(r.mensagem).replace(/\s+/g, ' ');
    }
  } catch (e) { console.warn('nfseDiscriminacao: de-para indisponível:', e.message); }
  return _msgs;
}

// Nome curto do equipamento, na ordem em que o fiscal costuma listar.
const ROTULOS = [
  [/^CONSULT[ÓO]RIO/, 'CONSULTÓRIOS'],
  [/^MOCHO/, 'MOCHO'],
  [/REFLETOR|^CAB(E[ÇC]OTE)?\s+REFL/, 'REFLETOR'],
  [/^KIT BV$/, 'KIT BV'],
  [/^ULTRASSOM/, 'ULTRASSOM'],
  [/^KIT TERM/, 'KIT TERM'],
  [/^AUTOCLAVE/, 'AUTOCLAVE'],
  [/^TIMEX/, 'TIMEX'],
  [/^COMPRESSOR/, 'COMPRESSOR'],
  [/^EASYSONIC/, 'EASYSONIC'],
  [/^KIT BANDEJA/, 'KIT BANDEJA'],
  [/^COMPUTADOR ALL IN ONE/, 'COMPUTADOR ALL IN ONE'],
  [/^KIT SUPORTE/, 'KIT SUPORTE'],
  [/BOMBA DE V[ÁA]CUO/, 'BOMBA DE VACUO'],
  [/^CART G \+ TOUCH/, 'CART G + TOUCH'],
  [/^CART G\b/, 'CART G']
];
const RE_INSTALACAO = /^SERVI[ÇC]O DE INSTALA[ÇC][ÃA]O\s+(?:DE\s+)?/i;

function rotuloInstalacao(descricao) {
  const resto = trim(String(descricao).toUpperCase().replace(RE_INSTALACAO, ''))
    .replace(/\((?:TODOS|G\d)[^)]*\)?/g, '')            // "(TODOS MODELOS)", "(G1/G2/G3)"
    .replace(/\s+/g, ' ').trim();
  for (let i = 0; i < ROTULOS.length; i++) if (ROTULOS[i][0].test(resto)) return { rotulo: ROTULOS[i][1], ordem: i };
  return { rotulo: resto, ordem: ROTULOS.length };
}

// Troca o "REF. PEDIDO ...." da mensagem fixa pelo número; sem pedido, tira o trecho.
function preencherPedido(msg, ped) {
  let m = trim(msg).replace(/\s+/g, ' ');
  if (!/REF\.?\s*PEDIDO/i.test(m)) return m;
  if (!ped) return trim(m.replace(/\s*-?\s*REF\.?\s*PEDIDO\s*:?[\s.]*(\/\d+)?\s*$/i, ''));
  m = m.replace(/(REF\.?\s*PEDIDO)\s*:?\s*\.{2,}\s*/i, `$1 ${ped}`);
  if (/REF\.?\s*PEDIDO\s*:?\s*$/i.test(m)) m = m.replace(/(REF\.?\s*PEDIDO)\s*:?\s*$/i, `$1 ${ped}`);
  return trim(m);
}

// itens: [{ codigo, descricao, quantidade, valorTotal, pedido }]
function montarDiscriminacao(itens) {
  const lista = Array.isArray(itens) ? itens : [];
  if (/^(0|false|off|nao|não)$/i.test(trim(process.env.NFSE_DESCRICAO_PADRAO))) {
    return lista.map((i) => `${i.descricao}${i.quantidade > 1 ? ` (${i.quantidade}x)` : ''} - R$ ${N(i.valorTotal).toFixed(2)}`).join(' | ');
  }
  const ped = [...new Set(lista.map((i) => trim(i.pedido)).filter(Boolean))].join(', ');
  const msgs = mensagens();
  const fixas = [], instal = [], outros = [];
  for (const i of lista) {
    const fixa = msgs[trim(i.codigo)];
    if (fixa) { if (!fixas.includes(fixa)) fixas.push(fixa); continue; }
    // tira o código numérico que alguns cadastros trazem no começo ("118062000 - SERVIÇOS DE COBRANÇA")
    const desc = trim(i.descricao).replace(/\s+/g, ' ').replace(/^\d{6,9}\s*-\s*/, '');
    if (RE_INSTALACAO.test(desc)) {
      const r = rotuloInstalacao(desc);
      if (r.rotulo && !instal.find((x) => x.rotulo === r.rotulo)) instal.push(r);
    } else if (desc && !outros.includes(desc)) outros.push(desc);
  }
  const partes = [];
  if (instal.length) {
    instal.sort((a, b) => a.ordem - b.ordem);   // sort estável: os sem rótulo conhecido mantêm a ordem dos itens
    partes.push('SERVIÇO DE INSTALAÇÃO DE ' + instal.map((x) => x.rotulo).join(' / '));
  }
  partes.push(...outros);
  const textos = fixas.map((m) => preencherPedido(m, ped));
  if (partes.length) textos.push(partes.join(' + ') + (ped ? ` - REF PEDIDO: ${ped}` : ''));
  const txt = textos.join(' | ');
  return txt.length > MAX ? txt.slice(0, MAX - 3).trim() + '...' : txt;
}

module.exports = { montarDiscriminacao, rotuloInstalacao, preencherPedido };

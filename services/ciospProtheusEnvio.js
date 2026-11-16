// services/ciospProtheusEnvio.js — o pedido do CIOSP indo para o Protheus pelo REST do
// Diego (PedidoVenda/incluir): monta o JSON, lê a resposta e decide o estado do envio
// (spec 2026-11-13-ciosp-inserir-protheus-design.md, seções 5 e 6).
//
// PURO: sem banco e sem rede. Quem chama o Protheus é services/protheusPedidoVenda.js;
// quem grava é a rota POST /ciosp/adm/protheus/:uuid/lancar.

const { trim, soDig, n2 } = require('./ciospDocs');

// C5_IDPORTA: portal B2B usa de 1.223 a 104.539, Shopify 500.000+. O CIOSP é 700.000+.
// A faixa muda só em teste (CIOSP_PROTHEUS_FAIXA), para um teste no REST do Diego
// nunca ocupar o id_externo de um pedido real.
const FAIXA_CIOSP = 700000;
const idExterno = (pedidoId, faixa = FAIXA_CIOSP) => Number(faixa || FAIXA_CIOSP) + Number(pedidoId);
const faixaDe = (env = process.env) => {
  const n = Number(env.CIOSP_PROTHEUS_FAIXA);
  return Number.isInteger(n) && n > 0 ? n : FAIXA_CIOSP;
};

const TRAVA_MS = 4 * 60 * 1000;   // "enviando" mais novo que isso barra novo envio

const MENSAGEM = {
  incerto: 'Não deu para confirmar. Tente de novo: o Protheus não duplica o pedido.',
  sem_licenca: 'Protheus sem licença disponível no momento. Tente de novo em alguns instantes.',
  em_andamento: 'Envio em andamento: aguarde a resposta do Protheus.'
};

// Condição de pagamento do Protheus para a forma escolhida. "Parcelada": a condição
// varia pelas parcelas — cartão 400 = 1x, 409 = 10x ("SE + Nx" no SE4).
function condicaoProposta(forma, parcelas) {
  const cond = trim(forma && forma.protheus_condicao);
  if (!cond) return null;
  if (!(forma && forma.protheus_condicao_parcelada)) return cond;
  const n = Math.max(1, Math.round(Number(parcelas) || 0));
  const codigo = Number(cond) + n - 1;
  if (!Number.isFinite(codigo) || codigo > 999) return null;
  return String(codigo).padStart(3, '0');
}

// "+55 (13) 99730-6455" → { ddd: '13', numero: '997306455' }. A1_DDD/A1_TEL e
// A1_DDDCEL/A1_FAX são campos separados no Protheus.
function separarFone(v) {
  let d = soDig(v);
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  if (d.length >= 10) return { ddd: d.slice(0, 2), numero: d.slice(2) };
  return { ddd: '', numero: d };
}

const semAcento = (v) => trim(v).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/\s+/g, ' ');

// Texto livre que vai para a nota: só ASCII (a ida ao Protheus já quebrou UTF-8 no
// SolicCompra, que é o molde do endpoint). "·" vira "-"; acento sai; caixa fica.
const ascii = (v) => trim(v).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/·/g, '-').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();

// A1_NREDUZ: até 20 caracteres sem partir palavra.
function nomeReduzido(nome) {
  const palavras = semAcento(nome).split(' ').filter(Boolean);
  if (!palavras.length) return '';
  if (palavras[0].length > 20) return palavras[0].slice(0, 20);
  let s = palavras[0];
  for (const p of palavras.slice(1)) {
    if ((s + ' ' + p).length > 20) break;
    s += ' ' + p;
  }
  return s;
}

// AAAA-MM-DD. O node-pg entrega DATE como meia-noite LOCAL: formatar com os getters
// locais (toISOString em UTC voltaria um dia em fuso positivo).
function dataIso(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = trim(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

// O JSON do contrato (seção 5.1 da spec).
// Código e loja do cliente vêm SÓ das escolhas: a rota já resolveu pela proposta
// (vazios para cliente novo). O cliente_cod do pedido pode ser de outro documento.
function montarEnvio({ pedido, itens, escolhas = {}, simular = false, usuario = '', faixa = FAIXA_CIOSP }) {
  const p = pedido || {};
  const esc = escolhas || {};
  const doc = soDig(p.cliente_doc);
  const pj = doc.length === 14;
  const fone = separarFone(p.cliente_fone);
  const cel = separarFone(p.cliente_celular);
  const telefone = fone.numero ? fone : cel;
  const celular = cel.numero ? cel : fone;
  const origem = ascii(`${trim(p.edicao)} - pedido ${p.numero}`);
  const mensagem = [origem, ascii(esc.mensagem)].filter(Boolean).join(' - ').slice(0, 500);
  const tes = esc.tes || {};

  return {
    filial: '01',
    simular: !!simular,
    id_externo: idExterno(p.id, faixa),
    origem,
    usuario: trim(usuario),
    cliente: {
      cgc: doc,
      codigo: trim(esc.cliente_codigo),
      loja: trim(esc.cliente_loja),
      pessoa: pj ? 'J' : 'F',
      nome: semAcento(p.cliente_nome),
      nome_reduzido: nomeReduzido(p.cliente_nome),
      genero: pj ? 'E' : trim(esc.genero || p.cliente_genero).toUpperCase(),
      data_nascimento: dataIso(esc.nascimento || p.cliente_nascimento),
      rg: pj ? '' : trim(p.cliente_rg_ie),
      ie: pj ? soDig(p.cliente_rg_ie) : '',
      email: trim(p.cliente_email),
      ddd: telefone.ddd, telefone: telefone.numero,
      ddd_celular: celular.ddd, celular: celular.numero,
      cep: soDig(p.cliente_cep),
      endereco: semAcento(p.cliente_endereco),
      bairro: semAcento(p.cliente_bairro),
      cod_mun: trim(esc.cod_mun),
      municipio: semAcento(p.cliente_cidade),
      uf: trim(p.cliente_uf).toUpperCase()
    },
    pedido: {
      tipo_gnatus: trim(esc.bu),
      vendedor: trim(esc.vendedor),
      condicao: trim(esc.condicao),
      forma_pagto: trim(esc.forma_pagto),
      cartao_autenticacao: trim(esc.cartao_autenticacao),
      transportadora: trim(esc.transportadora),
      tipo_frete: trim(esc.tipo_frete) || 'C',
      frete: n2(p.frete_valor),
      despesa: n2(p.acrescimo_norte),
      fat_parcial: trim(esc.fat_parcial) === 'S' ? 'S' : 'N',
      mensagem_nota: mensagem,
      itens: [...(itens || [])]
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .map((it, i) => ({
          item: String(i + 1).padStart(2, '0'),
          produto: trim(it.produto),
          quantidade: Math.round(Number(it.quantidade) || 0),
          preco: n2(it.preco),
          tes: trim(tes[it.seq])
        }))
    }
  };
}

const numeroOuNulo = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function inconsistenciasDe(corpo) {
  const lista = (corpo && (corpo.inconsistencias || corpo.INCONSISTENCIAS)) || [];
  if (!Array.isArray(lista)) return [];
  return lista.map(i => ({
    etapa: trim(i && i.etapa), item: trim(i && i.item), campo: trim(i && i.campo),
    mensagem: trim(i && (i.mensagem || i.message))
  }));
}

// A resposta do endpoint (seção 5.3) → o que a intranet faz com ela. `simular` é o que
// a intranet pediu: resposta com outro "simulado" não é confiável (incerto).
function interpretarResposta({ http, corpo, erro, simular = false } = {}) {
  const base = { pedido: null, cliente: null, total: null, total_mercadoria: null, simulado: false, inconsistencias: [], mensagem: null };
  if (erro === 'CONFIG') return { ...base, resultado: 'recusado', mensagem: 'API do Protheus não configurada no servidor.' };
  if (erro) return { ...base, resultado: 'incerto', mensagem: MENSAGEM.incerto };

  const status = trim(corpo && corpo.status).toUpperCase();
  const c = corpo && corpo.cliente;
  const lido = {
    ...base,
    cliente: c ? { codigo: trim(c.codigo), loja: trim(c.loja), criado: c.criado === true } : null,
    total: numeroOuNulo(corpo && corpo.total),
    total_mercadoria: numeroOuNulo(corpo && corpo.total_mercadoria),
    simulado: !!(corpo && corpo.simulado === true),
    inconsistencias: inconsistenciasDe(corpo)
  };

  if (Number(http) === 503) return { ...lido, resultado: 'sem_licenca', mensagem: MENSAGEM.sem_licenca };

  if (Number(http) === 200 && (status === 'CRIADO' || status === 'JA_EXISTIA')) {
    const num = trim(corpo.pedido);
    if (lido.simulado !== !!simular) {
      const n = /^\d{1,6}$/.test(num) ? num.padStart(6, '0') : null;
      return {
        ...lido, resultado: 'incerto', pedido: n,
        mensagem: `O Protheus respondeu simulado=${lido.simulado ? 'sim' : 'não'} para simular=${simular ? 'sim' : 'não'}.` +
          (n ? ` Confira o pedido ${n} no Protheus antes de tentar de novo.` : ' Confira no Protheus antes de tentar de novo.')
      };
    }
    if (/^\d{1,6}$/.test(num)) {
      return { ...lido, resultado: status === 'CRIADO' ? 'criado' : 'ja_existia', pedido: num.padStart(6, '0') };
    }
    if (status === 'CRIADO' && lido.simulado) return { ...lido, resultado: 'criado' };
    return { ...lido, resultado: 'incerto', mensagem: MENSAGEM.incerto };
  }

  if (Number(http) === 422 && status === 'REJEITADO') {
    const mensagem = (lido.inconsistencias[0] && lido.inconsistencias[0].mensagem)
      || trim(corpo.mensagem || corpo.message) || 'O Protheus recusou o pedido.';
    return { ...lido, resultado: 'recusado', mensagem };
  }

  if (Number(http) === 409) {
    return { ...lido, resultado: 'incerto', mensagem: 'O Protheus ainda está gravando a primeira tentativa. ' + MENSAGEM.incerto };
  }

  // Outro 4xx (400 de validação, 401, 404…): o endpoint recusou antes de gravar.
  if (Number(http) >= 400 && Number(http) < 500) {
    const mensagem = (lido.inconsistencias[0] && lido.inconsistencias[0].mensagem)
      || trim(corpo && (corpo.mensagem || corpo.message))
      || `O Protheus recusou o pedido (HTTP ${http}).`;
    return { ...lido, resultado: 'recusado', mensagem };
  }

  return { ...lido, resultado: 'incerto', mensagem: MENSAGEM.incerto };
}

// O Protheus devolveu um nº: adotar? Só se o pedido de lá é do mesmo CPF/CNPJ
// (conferirNumeroProtheus). Um JA_EXISTIA é de uma tentativa anterior: as escolhas
// desta podem não ter sido aplicadas.
function decidirAdocao({ resultado, pedido, conferido }) {
  if (conferido === 'divergente') {
    return { adotar: false, mensagem: `O pedido ${pedido} do Protheus é de outro CPF/CNPJ: peça para excluí-lo no Protheus e tente de novo.` };
  }
  return {
    adotar: true,
    aviso: resultado === 'ja_existia'
      ? `O Protheus já tinha este pedido (tentativa anterior): as escolhas desta tentativa podem não ter sido aplicadas. Confira o pedido ${pedido} no Protheus.`
      : null
  };
}

const estadoEnvio = (resultado) => (
  resultado === 'criado' || resultado === 'ja_existia' ? 'criado'
    : resultado === 'recusado' ? 'recusado' : 'incerto');

function envioTravado(pedido, agora = new Date()) {
  if (!pedido || pedido.protheus_envio !== 'enviando' || !pedido.protheus_envio_em) return false;
  return agora.getTime() - new Date(pedido.protheus_envio_em).getTime() < TRAVA_MS;
}

module.exports = {
  FAIXA_CIOSP, TRAVA_MS, MENSAGEM,
  idExterno, faixaDe, condicaoProposta, separarFone, semAcento, ascii, nomeReduzido, dataIso,
  montarEnvio, interpretarResposta, decidirAdocao, estadoEnvio, envioTravado
};

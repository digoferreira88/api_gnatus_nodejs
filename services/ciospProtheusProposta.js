// services/ciospProtheusProposta.js — o painel "Lançar no Protheus" da fila do ADM:
// o que ele propõe (cliente, cabeçalho, itens, totais) e o que falta para o botão
// "Inserir no Protheus e finalizar" liberar (spec 2026-11-13, seção 4).
//
// PURO: recebe o pedido e o que já foi lido do Protheus (services/ciospProtheus.js)
// e devolve a proposta. As mesmas faltas valem na tela e no servidor — o servidor
// confere de novo antes de enviar.

const { trim, soDig, n2, normalizarGenero, normalizarData } = require('./ciospDocs');
const { condicaoProposta, semAcento, dataIso } = require('./ciospProtheusEnvio');
const { pendenciasAntesDoProtheus } = require('./ciospFluxo');

// As 10 TES usadas no CIOSP 2026, na ordem de uso: aparecem primeiro na lista.
const TES_CIOSP_2026 = ['530', '531', '575', '576', '593', '574', '625', '650', '624', '554'];

function ordenarTes(tes) {
  const pos = (c) => { const i = TES_CIOSP_2026.indexOf(trim(c)); return i < 0 ? 999 : i; };
  return [...(tes || [])].sort((a, b) => (pos(a.codigo) - pos(b.codigo)) || String(a.codigo).localeCompare(String(b.codigo)));
}

// CC2 pela cidade do pedido, sem acento e sem caixa. Só devolve quando há exatamente um.
function acharMunicipio(lista, cidade) {
  if (!Array.isArray(lista)) return null;
  const alvo = semAcento(cidade);
  if (!alvo) return null;
  const achados = lista.filter(m => semAcento(m.nome) === alvo);
  return achados.length === 1 ? { cod_mun: trim(achados[0].cod_mun), nome: trim(achados[0].nome) } : null;
}

const temErro = (x) => !x || !!x.erro;
const naLista = (lista, codigo) => Array.isArray(lista) && lista.some(i => trim(i.codigo) === trim(codigo));
const qtdInteira = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0; };
const descricaoCurta = (it) => trim(it.descricao).slice(0, 60) || `item ${it.seq}`;

// Aviso do item que impede o envio (o primeiro que valer).
function avisoItem(it, produtos) {
  const cod = trim(it.produto);
  if (!cod) return `item sem código do Protheus: ${descricaoCurta(it)}`;
  if (!qtdInteira(it.quantidade)) return `quantidade inteira em ${descricaoCurta(it)}`;
  if (temErro(produtos)) return null;
  const info = produtos[cod];
  if (!info) return `produto ${cod} não existe no Protheus`;
  if (info.bloqueado) return `produto ${cod} bloqueado no Protheus`;
  if (info.anvisa_barrado) return `produto ${cod} barrado pela ANVISA`;
  return null;
}

function montarProposta({ pedido, itens, membro, forma, cliente, municipios, produtos, listas, ultima, ativo }) {
  const p = pedido || {};
  const pj = soDig(p.cliente_doc).length === 14;

  // ------------------------------------------------ cliente
  let cli;
  if (temErro(cliente)) {
    cli = { situacao: 'indisponivel', lojas: [], codigo: null, loja: null, nome: null, bloqueado: false, condicao_fixa: null };
  } else {
    const lojas = cliente.lojas || [];
    const doPedido = lojas.find(l => trim(l.codigo) === trim(p.cliente_cod) && trim(l.loja) === trim(p.cliente_loja));
    const achada = lojas.length === 1 ? lojas[0] : doPedido;
    cli = achada
      ? { situacao: 'encontrado', lojas, codigo: trim(achada.codigo), loja: trim(achada.loja), nome: achada.nome || null,
        bloqueado: !!achada.bloqueado, condicao_fixa: trim(achada.condicao) || null }
      : { situacao: lojas.length ? 'varias_lojas' : 'novo', lojas, codigo: null, loja: null, nome: null, bloqueado: false, condicao_fixa: null };
  }
  cli.pessoa = pj ? 'J' : 'F';
  cli.municipio_sugerido = cli.situacao === 'novo' ? acharMunicipio(municipios, p.cliente_cidade) : null;
  const listaMunicipios = cli.situacao === 'novo' && Array.isArray(municipios) ? municipios : [];

  // ------------------------------------------------ itens
  const lidos = [...(itens || [])].sort((a, b) => Number(a.seq) - Number(b.seq)).map(it => {
    const info = temErro(produtos) ? null : produtos[trim(it.produto)];
    const preco = n2(it.preco), quantidade = Number(it.quantidade) || 0;
    return {
      seq: it.seq, produto: trim(it.produto), descricao: it.descricao, quantidade, preco,
      total: n2(preco * quantidade), servico: !!(info && info.tipo === 'SV'), aviso: avisoItem(it, produtos)
    };
  });
  const misto = lidos.some(i => i.servico) && lidos.some(i => !i.servico);
  const somaItens = n2(lidos.reduce((a, i) => a + i.total, 0));
  const frete = n2(p.frete_valor), acrescimo = n2(p.acrescimo_norte);

  // ------------------------------------------------ escolhas pré-preenchidas
  const cond = condicaoProposta(forma, p.parcelas);
  const padrao = {
    cliente_codigo: cli.codigo || '', cliente_loja: cli.loja || '',
    genero: trim(p.cliente_genero), nascimento: dataIso(p.cliente_nascimento),
    cod_mun: (cli.municipio_sugerido && cli.municipio_sugerido.cod_mun) || '',
    bu: trim(membro && membro.protheus_bu), vendedor: trim(membro && membro.protheus_vendedor),
    condicao: cond && !temErro(listas) && naLista(listas.condicoes, cond) ? cond : '',
    forma_pagto: trim(forma && forma.protheus_forma),
    cartao_autenticacao: '', transportadora: '', tipo_frete: 'C',
    fat_parcial: misto || p.entrega_parcial ? 'S' : 'N', mensagem: '',
    tes: Object.fromEntries(lidos.map(i => [i.seq, '']))
  };
  // A última tentativa só pré-preenche se é desta conferência: depois de uma devolução
  // (forma, itens ou cliente trocados) as escolhas antigas não valem. Pedido misto é
  // sempre faturamento parcial S (regra do MT410TOK) — o campo fica travado na tela.
  const valeUltima = ultima && ultima.escolhas &&
    !(p.conferido_em && ultima.enviado_em && new Date(ultima.enviado_em) < new Date(p.conferido_em));
  const escolhas = { ...padrao, ...(valeUltima ? ultima.escolhas : {}) };
  if (misto) escolhas.fat_parcial = 'S';

  // ------------------------------------------------ o que o ADM não resolve no painel
  const fixas = [];
  if (p.situacao !== 'conferido') fixas.push('pedido conferido');
  fixas.push(...pendenciasAntesDoProtheus(p));
  if (trim(p.protheus_pedido) && p.protheus_envio !== 'criado') fixas.push('o pedido já tem nº do Protheus informado à mão');
  if (p.protheus_envio === 'criado') fixas.push(`o pedido já está no Protheus (nº ${trim(p.protheus_pedido)})`);
  if (temErro(cliente)) fixas.push('Protheus indisponível para consultar o cliente');
  if (temErro(produtos)) fixas.push('Protheus indisponível para consultar os produtos');
  if (temErro(listas)) fixas.push('Protheus indisponível para consultar TES, condições e vendedores');
  if (cli.situacao === 'encontrado' && cli.bloqueado) fixas.push('cliente bloqueado no Protheus');
  for (const i of lidos) if (i.aviso) fixas.push(i.aviso);

  return {
    ativo: !!ativo,
    envio: { estado: p.protheus_envio || null, em: p.protheus_envio_em || null, tentativas: Number(p.protheus_tentativas) || 0 },
    cliente: cli,
    municipios: listaMunicipios,
    escolhas,
    itens: lidos,
    totais: { itens: somaItens, frete, acrescimo, total: n2(somaItens + frete + acrescimo) },
    misto,
    listas: temErro(listas) ? { bus: [], vendedores: [], condicoes: [], tes: [], transportadoras: [] } : listas,
    faltas_fixas: [...new Set(fixas)],
    _pedido: p
  };
}

// Código e loja que vão ao Protheus, decididos pela proposta — nunca o que veio no
// corpo sem conferência, nem o cliente_cod antigo do pedido: cliente novo vai vazio;
// loja única vai com ela; várias lojas, só uma loja deste cliente.
function clienteDoEnvio(proposta, escolhas) {
  const e = escolhas || {};
  const cli = proposta.cliente || {};
  const vazio = { cliente_codigo: '', cliente_loja: '' };
  if (cli.situacao !== 'encontrado' && cli.situacao !== 'varias_lojas') return vazio;
  const lojas = cli.lojas || [];
  const loja = lojas.length === 1 ? lojas[0]
    : lojas.find(l => trim(l.codigo) === trim(e.cliente_codigo) && trim(l.loja) === trim(e.cliente_loja));
  return loja ? { cliente_codigo: trim(loja.codigo), cliente_loja: trim(loja.loja) } : vazio;
}

// Tudo o que impede o envio com as escolhas do ADM. Vazio = pode enviar.
function faltasParaEnviar(proposta, escolhas) {
  const e = escolhas || {};
  const p = proposta._pedido || {};
  const cli = proposta.cliente || {};
  const listas = proposta.listas || {};
  const f = [...(proposta.faltas_fixas || [])];

  // ------------------------------------------------ cliente
  let loja = null;
  if (cli.situacao === 'encontrado' || cli.situacao === 'varias_lojas') {
    const lojas = cli.lojas || [];
    loja = lojas.length === 1 ? lojas[0]
      : lojas.find(l => trim(l.codigo) === trim(e.cliente_codigo) && trim(l.loja) === trim(e.cliente_loja));
    if (!loja) f.push('escolher a loja do cliente');
    else if (loja.bloqueado) f.push('cliente bloqueado no Protheus');
  }
  if (cli.situacao === 'novo') {
    const pj = cli.pessoa === 'J';
    if (!pj && !normalizarGenero(e.genero)) f.push('gênero do cliente');
    if (!normalizarData(e.nascimento)) f.push(pj ? 'data de abertura' : 'data de nascimento');
    if (!/^\d{5}$/.test(trim(e.cod_mun))) f.push('município do cliente');
    if (!trim(p.cliente_email)) f.push('e-mail do cliente');
    if (!soDig(p.cliente_fone) && !soDig(p.cliente_celular)) f.push('telefone ou celular do cliente');
    if (soDig(p.cliente_cep).length !== 8) f.push('CEP do cliente');
    if (!trim(p.cliente_endereco)) f.push('endereço do cliente');
    if (!trim(p.cliente_bairro)) f.push('bairro do cliente');
    if (!trim(p.cliente_uf)) f.push('UF do cliente');
  }

  // ------------------------------------------------ cabeçalho
  const campos = [['bu', 'BU'], ['vendedor', 'vendedor'], ['condicao', 'condição de pagamento'],
    ['forma_pagto', 'forma de pagamento no Protheus'], ['transportadora', 'transportadora']];
  for (const [k, rotulo] of campos) if (!trim(e[k])) f.push(rotulo);
  const tes = e.tes || {};
  const itens = proposta.itens || [];
  if (itens.some(i => !trim(tes[i.seq]))) f.push('TES em todos os itens');

  if (trim(e.bu) && !naLista(listas.bus, e.bu)) f.push(`BU ${trim(e.bu)} não existe no Protheus`);
  if (trim(e.vendedor) && !naLista(listas.vendedores, e.vendedor)) f.push(`vendedor ${trim(e.vendedor)} não existe ou está bloqueado`);
  if (trim(e.condicao) && !naLista(listas.condicoes, e.condicao)) f.push(`condição ${trim(e.condicao)} não existe`);
  for (const t of new Set(itens.map(i => trim(tes[i.seq])).filter(Boolean))) {
    if (!naLista(listas.tes, t)) f.push(`TES ${t} não existe ou está bloqueada`);
  }
  if (trim(e.transportadora) && !naLista(listas.transportadoras, e.transportadora)) f.push(`transportadora ${trim(e.transportadora)} não existe`);

  const fixa = loja ? trim(loja.condicao) : '';
  if (fixa && trim(e.condicao) && trim(e.condicao) !== fixa) f.push(`condição diferente da fixa do cliente (A1_COND = ${fixa})`);

  // ------------------------------------------------ pedido com produto e serviço
  if (proposta.misto) {
    if (n2(p.frete_valor) > 0 || n2(p.acrescimo_norte) > 0) f.push('pedido com produto e serviço não aceita frete nem acréscimo da Amazônia');
    if (trim(e.fat_parcial) !== 'S') f.push('faturamento parcial S (pedido com produto e serviço)');
  }
  return [...new Set(f)];
}

module.exports = { TES_CIOSP_2026, ordenarTes, acharMunicipio, montarProposta, faltasParaEnviar, clienteDoEnvio };

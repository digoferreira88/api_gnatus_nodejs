// services/ciospProtheus.js — o que o painel "Lançar no Protheus" lê do SQL Server do
// Protheus (SOMENTE LEITURA): cliente, municípios, produtos e as listas (BU, vendedor,
// condição, TES, transportadora). E carregarProposta(), que junta o pedido, a equipe,
// a forma de pagamento, a última tentativa e essas leituras (spec 2026-11-13, §6.2).
//
// Cada leitura devolve { erro: 'Protheus inacessível' } quando o SQL falha: o painel
// abre assim mesmo, com o motivo no botão. carregarProposta chama as leituras pelo
// module.exports, para o harness de teste poder trocá-las por dados de mentira.

const { q } = require('./ciospEdicao');
const D = require('./ciospDocs');
const { montarProposta, ordenarTes } = require('./ciospProtheusProposta');

const ERRO = { erro: 'Protheus inacessível' };
const CACHE_MS = 10 * 60 * 1000;
const t = (v) => String(v == null ? '' : v).trim();

let cache = { em: 0, valor: null };
const limparCache = () => { cache = { em: 0, valor: null }; };

async function consultar(app, sql, params) {
  return app.services.Protheus.connectAndQuery(sql, params);
}

async function lerCliente(app, doc) {
  try {
    const linhas = await consultar(app, `
      SELECT RTRIM(A1_COD) codigo, RTRIM(A1_LOJA) loja, RTRIM(A1_NOME) nome, A1_MSBLQL msblql, RTRIM(A1_COND) cond
        FROM SA1010 WITH (NOLOCK)
       WHERE D_E_L_E_T_ <> '*'
         AND REPLACE(REPLACE(REPLACE(RTRIM(A1_CGC), '.', ''), '/', ''), '-', '') = @doc`, { doc: D.soDig(doc) });
    const lojas = (linhas || []).map(l => ({
      codigo: t(l.codigo), loja: t(l.loja), nome: t(l.nome), bloqueado: t(l.msblql) === '1', condicao: t(l.cond) || null
    })).sort((a, b) => a.loja.localeCompare(b.loja));
    return { lojas };
  } catch (e) {
    console.warn('ciospProtheus/lerCliente:', e.message);
    return { ...ERRO };
  }
}

async function lerMunicipios(app, uf) {
  try {
    const linhas = await consultar(app, `
      SELECT RTRIM(CC2_CODMUN) cod_mun, RTRIM(CC2_MUN) nome
        FROM CC2010 WITH (NOLOCK)
       WHERE D_E_L_E_T_ <> '*' AND CC2_EST = @uf
       ORDER BY CC2_MUN`, { uf: t(uf).toUpperCase() });
    return (linhas || []).map(m => ({ cod_mun: t(m.cod_mun), nome: t(m.nome) }));
  } catch (e) {
    console.warn('ciospProtheus/lerMunicipios:', e.message);
    return { ...ERRO };
  }
}

// O campo que barra produto pela ANVISA ainda não existe no SB1 (o B1_XANVISA citado
// pelo Diego não está no dicionário em 16/11/2026). Quando existir, configure
// CIOSP_SB1_CAMPO_ANVISA=B1_XANVISA. Sem ele, nada é barrado aqui — o endpoint recusa.
function campoAnvisa() {
  const c = t(process.env.CIOSP_SB1_CAMPO_ANVISA).toUpperCase();
  return /^B1_[A-Z0-9]{1,8}$/.test(c) ? c : null;
}

async function lerProdutos(app, codigos) {
  const unicos = [...new Set((codigos || []).map(t).filter(Boolean))];
  if (!unicos.length) return {};
  try {
    const params = {};
    unicos.forEach((c, i) => { params[`c${i}`] = c; });
    const anvisa = campoAnvisa();
    const linhas = await consultar(app, `
      SELECT RTRIM(B1_COD) cod, RTRIM(B1_DESC) descr, B1_MSBLQL msblql, RTRIM(B1_TIPO) tipo, B1_IPI ipi,
             ${anvisa ? `RTRIM(${anvisa})` : "''"} anvisa
        FROM SB1010 WITH (NOLOCK)
       WHERE D_E_L_E_T_ <> '*' AND B1_COD IN (${unicos.map((_, i) => `@c${i}`).join(',')})`, params);
    const mapa = {};
    for (const l of linhas || []) {
      mapa[t(l.cod)] = {
        descricao: t(l.descr), bloqueado: t(l.msblql) === '1', tipo: t(l.tipo),
        anvisa_barrado: t(l.anvisa) === '2', ipi: Number(l.ipi) || 0
      };
    }
    return mapa;
  } catch (e) {
    console.warn('ciospProtheus/lerProdutos:', e.message);
    return { ...ERRO };
  }
}

const codDesc = (linhas) => (linhas || []).map(l => ({ codigo: t(l.codigo), descricao: t(l.descricao) }));

// BU (SX5 Z1), vendedores, condições, TES de saída e transportadoras não bloqueados.
// Mudam pouco: cache de 10 minutos (o painel abre a cada pedido).
async function lerListas(app) {
  if (cache.valor && Date.now() - cache.em < CACHE_MS) return cache.valor;
  try {
    const [bus, vendedores, condicoes, tes, transportadoras] = await Promise.all([
      consultar(app, `SELECT RTRIM(X5_CHAVE) codigo, RTRIM(X5_DESCRI) descricao FROM SX5010 WITH (NOLOCK)
                        WHERE D_E_L_E_T_ <> '*' AND X5_TABELA = 'Z1' ORDER BY X5_CHAVE`),
      consultar(app, `SELECT RTRIM(A3_COD) codigo, RTRIM(A3_NOME) descricao FROM SA3010 WITH (NOLOCK)
                        WHERE D_E_L_E_T_ <> '*' AND A3_MSBLQL <> '1' ORDER BY A3_NOME`),
      consultar(app, `SELECT RTRIM(E4_CODIGO) codigo, RTRIM(E4_DESCRI) descricao FROM SE4010 WITH (NOLOCK)
                        WHERE D_E_L_E_T_ <> '*' AND E4_MSBLQL <> '1' ORDER BY E4_CODIGO`),
      consultar(app, `SELECT RTRIM(F4_CODIGO) codigo, RTRIM(F4_TEXTO) descricao, RTRIM(F4_CF) cfop, F4_IPI ipi FROM SF4010 WITH (NOLOCK)
                        WHERE D_E_L_E_T_ <> '*' AND F4_TIPO = 'S' AND F4_MSBLQL <> '1'`),
      consultar(app, `SELECT RTRIM(A4_COD) codigo, RTRIM(A4_NOME) descricao FROM SA4010 WITH (NOLOCK)
                        WHERE D_E_L_E_T_ <> '*' AND A4_MSBLQL <> '1' ORDER BY A4_NOME`)
    ]);
    const valor = {
      bus: codDesc(bus), vendedores: codDesc(vendedores), condicoes: codDesc(condicoes),
      tes: ordenarTes((tes || []).map(l => ({ codigo: t(l.codigo), descricao: t(l.descricao), cfop: t(l.cfop), ipi: t(l.ipi) }))),
      transportadoras: codDesc(transportadoras)
    };
    cache = { em: Date.now(), valor };
    return valor;
  } catch (e) {
    console.warn('ciospProtheus/lerListas:', e.message);
    return { ...ERRO };
  }
}

// Junta tudo o que o painel precisa. Devolve a Proposta (ciospProtheusProposta) com
// _pedido e _ultima (a última tentativa, crua) — as rotas não mandam os dois à tela.
async function carregarProposta(app, pedido) {
  const { Pg } = app.services;
  const eu = module.exports;
  const itens = await D.lerItens(Pg, 'tab_ciosp_pedido_item', 'pedido_id', pedido.id);
  const membro = pedido.vendedor_id
    ? (await q(app, `SELECT protheus_vendedor, protheus_bu FROM tab_ciosp_equipe
                      WHERE edicao = $1 AND usuario_id = $2 AND ativo LIMIT 1`, [pedido.edicao, pedido.vendedor_id]))[0] || null
    : null;
  const forma = pedido.forma_pagto_id
    ? (await q(app, `SELECT id, nome, protheus_condicao, protheus_condicao_parcelada, protheus_forma
                       FROM tab_ciosp_forma_pagto WHERE id = $1`, [pedido.forma_pagto_id]))[0] || null
    : null;
  const ultima = (await q(app,
    `SELECT tentativa, simulado, escolhas, resultado, resposta, http, enviado_em
       FROM tab_ciosp_protheus_envio WHERE pedido_id = $1 ORDER BY tentativa DESC, id DESC LIMIT 1`, [pedido.id]))[0] || null;

  const [cliente, produtos, listas, municipios] = await Promise.all([
    eu.lerCliente(app, pedido.cliente_doc),
    eu.lerProdutos(app, itens.map(i => i.produto)),
    eu.lerListas(app),
    eu.lerMunicipios(app, pedido.cliente_uf)
  ]);

  const proposta = montarProposta({
    pedido, itens, membro, forma, cliente, municipios, produtos, listas, ultima,
    ativo: process.env.CIOSP_PROTHEUS_ATIVO === '1'
  });
  proposta._ultima = ultima;
  return proposta;
}

module.exports = { lerCliente, lerMunicipios, lerProdutos, lerListas, limparCache, carregarProposta };

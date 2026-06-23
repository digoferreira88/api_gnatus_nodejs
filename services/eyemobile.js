// services/eyemobile.js — adapter da API EyeMobile (api.eyemobile.com.br/v1).
// Auth por headers X-EYEMOBILE-ACCESS-KEY / X-EYEMOBILE-SECRET-KEY (.env).
// Usado pelo importador de preços: lista produtos de um cardápio e atualiza o
// preço por produto (PUT individual — preserva os demais campos do item).

const BASE = () => (process.env.EYEMOBILE_BASE_URL || 'https://api.eyemobile.com.br/v1').replace(/\/$/, '');
const AK = () => String(process.env.EYEMOBILE_ACCESS_KEY || '').trim();
const SK = () => String(process.env.EYEMOBILE_SECRET_KEY || '').trim();
const disponivel = () => !!(AK() && SK());
const headers = (extra = {}) => ({ 'X-EYEMOBILE-ACCESS-KEY': AK(), 'X-EYEMOBILE-SECRET-KEY': SK(), accept: 'application/json', ...extra });

async function _req(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(BASE() + path, {
      method,
      headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const txt = await r.text();
    let j; try { j = txt ? JSON.parse(txt) : null; } catch { j = txt; }
    if (!r.ok) { const e = new Error(`EyeMobile HTTP ${r.status} ${(j && (j.message || j.errorMessage)) || ''}`); e.status = r.status; e.body = j; throw e; }
    return j;
  } finally { clearTimeout(timer); }
}

// Lista produtos de um cardápio (paginado), deduplicando por produto-catálogo.
// Retorna { produtoId, sku, nome, precoAtual, raw } por produto.
async function listarProdutosMenu(menuId) {
  const out = new Map();
  let off = 0;
  for (let i = 0; i < 60; i++) {
    const j = await _req('GET', `/menus/${menuId}/products?limit=100&offset=${off}`);
    const data = (j && j.data) || [];
    for (const p of data) {
      const prod = p.product || {};
      const produtoId = String(prod.id || '').trim();
      if (!produtoId || out.has(produtoId)) continue;
      out.set(produtoId, {
        produtoId,
        sku: String(prod.sku || p.sku || '').trim(),
        nome: String(prod.name || p.nickname || '').trim(),
        precoAtual: Number(p.price || 0),
        raw: p
      });
    }
    if (!j || !j.has_more) break;
    off += 100;
  }
  return [...out.values()];
}

// Atualiza o preço de 1 produto no cardápio, preservando os demais campos.
async function atualizarPreco(menuId, item, novoPreco) {
  const p = item.raw || {};
  const body = {
    price: novoPreco,
    nickname: p.nickname ?? null,
    sku: p.sku ?? null,
    measure: p.measure ?? 1,
    valid_until: p.valid_until ?? null,
    available_for_sale: p.available_for_sale !== false,
    product_group_id: (p.product_group && p.product_group.id) || p.product_group_id || undefined,
    set_price_on_catalog: !!p.set_price_on_catalog
  };
  return _req('PUT', `/menus/${menuId}/products/${item.produtoId}`, body);
}

// Cardápios alvo do importador de preços da planilha do comercial (aba Geral):
//   49456 = principal (preço da planilha); 54643 = regional/frete (+3%).
const MENUS_ALVO = [
  { menuId: '49456', nome: 'Principal · PRODUTOS ODONTOLÓGICOS', fator: 1.0 },
  { menuId: '54643', nome: 'Regional / Frete (+3%)', fator: 1.03 }
];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function _parsePlanilha(itens) {
  const m = new Map();
  (itens || []).forEach(it => {
    const c = String(it.codigo == null ? '' : it.codigo).trim();
    const v = Number(it.valor);
    if (c && !isNaN(v) && v > 0) m.set(c, { valor: v, descricao: String(it.descricao || '').trim() });
  });
  return m;
}

// roda tarefas com concorrência limitada
async function _pool(items, limit, fn) {
  const res = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) { const idx = i++; res[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return res;
}

// PREVIEW: o que mudaria em cada cardápio (sem escrever nada).
async function calcularAlteracoes(itens) {
  const planilha = _parsePlanilha(itens);
  const usados = new Set();
  const menus = [];
  for (const mn of MENUS_ALVO) {
    const prods = await listarProdutosMenu(mn.menuId);
    const alterar = []; let jaOk = 0, semPlan = 0;
    for (const p of prods) {
      const pl = planilha.get(p.sku);
      if (!pl) { semPlan++; continue; }
      usados.add(p.sku);
      const novo = round2(pl.valor * mn.fator);
      if (Math.abs(novo - round2(p.precoAtual)) >= 0.01) alterar.push({ produtoId: p.produtoId, sku: p.sku, nome: p.nome || pl.descricao, precoAtual: round2(p.precoAtual), precoNovo: novo });
      else jaOk++;
    }
    menus.push({ menuId: mn.menuId, nome: mn.nome, fator: mn.fator, totalProdutos: prods.length, qtdAlterar: alterar.length, qtdJaOk: jaOk, qtdSemNaPlanilha: semPlan, alterar });
  }
  const planilhaSemProduto = [...planilha.keys()].filter(c => !usados.has(c)).map(c => ({ codigo: c, descricao: planilha.get(c).descricao }));
  return { menus, planilhaSemProduto, qtdPlanilha: planilha.size, geradoEm: new Date().toISOString() };
}

// APLICAR: recalcula e publica (PUT por produto que muda), com concorrência.
async function aplicarAlteracoes(itens) {
  const planilha = _parsePlanilha(itens);
  const resultado = [];
  for (const mn of MENUS_ALVO) {
    const prods = await listarProdutosMenu(mn.menuId);
    const mudar = [];
    for (const p of prods) {
      const pl = planilha.get(p.sku); if (!pl) continue;
      const novo = round2(pl.valor * mn.fator);
      if (Math.abs(novo - round2(p.precoAtual)) >= 0.01) mudar.push({ p, novo });
    }
    let aplicados = 0, erros = 0; const detalheErros = [];
    await _pool(mudar, 6, async ({ p, novo }) => {
      try { await atualizarPreco(mn.menuId, p, novo); aplicados++; }
      catch (e) { erros++; if (detalheErros.length < 10) detalheErros.push(`${p.sku} (${p.nome}): ${e.message}`); }
    });
    resultado.push({ menuId: mn.menuId, nome: mn.nome, tentados: mudar.length, aplicados, erros, detalheErros });
  }
  return { resultado, geradoEm: new Date().toISOString() };
}

// ===== Cadastro de produtos faltantes =====

// planilha agrupada por código (coleta as ABAs em que cada produto aparece)
function _parsePlanilhaMulti(itens) {
  const m = new Map();
  (itens || []).forEach(it => {
    const c = String(it.codigo == null ? '' : it.codigo).trim();
    const v = Number(it.valor);
    if (!c || isNaN(v) || v <= 0) return;
    if (!m.has(c)) m.set(c, { valor: v, descricao: String(it.descricao || '').trim(), abas: new Set() });
    const aba = String(it.aba || '').trim();
    if (aba) m.get(c).abas.add(aba);
  });
  return m;
}

// SKUs existentes no catálogo (GET /products)
async function _catalogoSkus() {
  const set = new Set(); let off = 0;
  for (let i = 0; i < 60; i++) {
    const j = await _req('GET', `/products?limit=100&offset=${off}`);
    const d = (j && j.data) || [];
    d.forEach(p => { const s = String(p.sku || '').trim(); if (s) set.add(s); });
    if (!j || !j.has_more) break;
    off += 100;
  }
  return set;
}

// Map(ABA-nome-MAIÚSCULO -> product_group_id) de um cardápio.
async function gruposDoMenu(menuId) {
  const mg = await _req('GET', `/menus/${menuId}/product_groups?limit=100&offset=0`);
  const ids = (((mg && mg.data) || []).map(g => String(g.id)));
  const nomeById = new Map(); let off = 0;
  for (let i = 0; i < 20; i++) {
    const j = await _req('GET', `/product_groups?limit=100&offset=${off}`);
    const d = (j && j.data) || [];
    d.forEach(g => nomeById.set(String(g.id), String(g.name || '').trim().toUpperCase()));
    if (!j || !j.has_more) break;
    off += 100;
  }
  const map = new Map();
  ids.forEach(id => { const nm = nomeById.get(id); if (nm && !map.has(nm)) map.set(nm, id); });
  return map;
}

// PREVIEW dos cadastros: o que dá pra criar (novo+limpo) e o que precisa revisão.
async function calcularCadastros(itens) {
  const planilha = _parsePlanilhaMulti(itens);
  const [catalogo, menuPrinc, g49456, g54643] = await Promise.all([
    _catalogoSkus(), listarProdutosMenu('49456'), gruposDoMenu('49456'), gruposDoMenu('54643')
  ]);
  const noMenu = new Set(menuPrinc.map(p => p.sku));
  const gruposPorMenu = { '49456': g49456, '54643': g54643 };
  const criar = [], revisar = [];
  for (const [codigo, info] of planilha) {
    if (noMenu.has(codigo)) continue;                       // já está no cardápio principal
    const abas = [...info.abas];
    if (/[\s+/]/.test(codigo)) { revisar.push({ codigo, nome: info.descricao, motivo: 'Código composto/combo — cadastrar manual' }); continue; }
    if (catalogo.has(codigo)) { revisar.push({ codigo, nome: info.descricao, motivo: 'SKU já existe no catálogo — adicionar ao cardápio manualmente' }); continue; }
    const destinos = [];
    for (const mn of MENUS_ALVO) {
      const gmap = gruposPorMenu[mn.menuId];
      for (const aba of abas) {
        const gid = gmap.get(aba.toUpperCase());
        if (gid) destinos.push({ menuId: mn.menuId, menuNome: mn.nome, aba, groupId: gid, preco: round2(info.valor * mn.fator) });
      }
    }
    if (!destinos.length) { revisar.push({ codigo, nome: info.descricao, motivo: `Grupo (ABA: ${abas.join('/') || '—'}) não encontrado nos cardápios` }); continue; }
    criar.push({ codigo, nome: info.descricao, valor: info.valor, abas, destinos });
  }
  return { criar, revisar, qtdCriar: criar.length, qtdRevisar: revisar.length };
}

// APLICAR: cria o produto-catálogo (1x) e adiciona aos cardápios/grupos. Recalcula
// no servidor (não confia no cliente). Só cria os "novos+limpos".
async function aplicarCadastros(itens) {
  const prev = await calcularCadastros(itens);
  const resultado = [];
  for (const c of prev.criar) {
    try {
      const novo = await _req('POST', '/products', { name: c.nome.slice(0, 120) || c.codigo, sku: c.codigo, status: 1 });
      const produtoId = String((novo && (novo.id || (novo.data && novo.data.id) || novo.product_id)) || '').trim();
      if (!produtoId) throw new Error('catálogo não retornou id do produto');
      let adic = 0; const erros = [];
      for (const d of c.destinos) {
        try {
          await _req('POST', `/menus/${d.menuId}/products`, { product_id: produtoId, price: d.preco, measure: 1, available_for_sale: true, set_price_on_catalog: false, product_group_id: d.groupId });
          adic++;
        } catch (e) { if (erros.length < 6) erros.push(`${d.menuId}/${d.aba}: ${e.message}`); }
      }
      resultado.push({ codigo: c.codigo, nome: c.nome, produtoId, adicionados: adic, destinos: c.destinos.length, erros });
    } catch (e) {
      resultado.push({ codigo: c.codigo, nome: c.nome, erro: e.message });
    }
  }
  return { resultado, ignorados: prev.revisar, geradoEm: new Date().toISOString() };
}

module.exports = { disponivel, listarProdutosMenu, atualizarPreco, calcularAlteracoes, aplicarAlteracoes, calcularCadastros, aplicarCadastros, gruposDoMenu, MENUS_ALVO, BASE };

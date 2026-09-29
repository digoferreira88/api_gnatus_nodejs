// services/shopifyProdutos.js — espelho de PRODUTOS Protheus -> loja Shopify.
//
// Padrão idêntico ao services/pipefyClientes.js: tabela de ESTADO em Postgres
// (tab_shopify_produto_sync) guarda product_id/variant_id + hash por SKU, o diff é
// feito no Postgres e SÓ O DELTA vai à API.
//
// ⚠️ A REGRA QUE GOVERNA ESTE ARQUIVO — quem é dono de cada campo:
//     Protheus  : SKU, preço, situação (e o título, SÓ na criação)
//     Shopify   : descrição, fotos, peso, dimensões, SEO, coleções — NUNCA tocados
//
// Daí a assimetria entre criar e atualizar, que é a principal armadilha aqui:
//   `productSet` é upsert idempotente, mas para campos de LISTA (mídia, metafields,
//   variantes) ele APAGA o que não vier no input. Chamá-lo para atualizar preço
//   limparia silenciosamente as fotos e descrições cadastradas na loja. Por isso:
//     criar             -> productSet          (produto novo: não há o que perder)
//     atualizar preço   -> productVariantsBulkUpdate  (cirúrgico)
//     atualizar situação-> productUpdate { id, status } e mais nada
//
// Produto NASCE EM DRAFT: sem foto e sem descrição ele não pode cair na loja ao vivo.
// Quem cadastra o conteúdo publica. (Por isso também não precisamos de escopo de
// publicação — read_products + write_products bastam.)
//
// O espelho é ADITIVO: nunca apaga. Produto que sai do filtro ou é bloqueado no
// Protheus vira ARCHIVED (reversível) — e mesmo isso só com SHOPIFY_ARQUIVAR=1.
//
// Config (.env):
//   SHOPIFY_SHOP / SHOPIFY_TOKEN   credenciais do custom app (sem elas: dormente)
//   SHOPIFY_ATIVO=1                liga o espelho (nasce '0')
//   SHOPIFY_SIMULAR=1              dry-run: calcula tudo e NÃO chama a API (nasce '1')
//   SHOPIFY_ARQUIVAR=1             arquiva quem sai do filtro (nasce '0')
//   SHOPIFY_TABELA_PRECO           tabela DA1 do preço (padrão '007')
//   SHOPIFY_TETO_DIA / _CICLO      tetos de gravação (padrão 500 / 100)

const Api = require('./shopifyApi');
const Catalogo = require('./shopifyCatalogo');

const trim = (v) => String(v == null ? '' : v).trim();
const intEnv = (k, def) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) && n >= 0 ? n : def; };
const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

const ATIVO = () => trim(process.env.SHOPIFY_ATIVO) === '1';
const SIMULAR = () => trim(process.env.SHOPIFY_SIMULAR || '1') === '1';
const ARQUIVAR = () => trim(process.env.SHOPIFY_ARQUIVAR || '0') === '1';
const TETO_DIA = () => intEnv('SHOPIFY_TETO_DIA', 500);
const TETO_CICLO = () => intEnv('SHOPIFY_TETO_CICLO', 100);
const disponivel = () => Api.configurado() && ATIVO();

// Trava de ciclo único no processo (o pm2 roda uma instância da API).
let emExecucao = false;

// ---------------- Mutations / queries ----------------

// Página pequena de propósito: o custo da query no bucket do Shopify é
// first(produtos) × first(variantes). Com 50×10 o custo passava de 500 pontos e a
// própria chamada disparava THROTTLED. 25×20 cobre produtos com muitas variantes
// custando ~1/3 disso.
const Q_PRODUTOS = `
  query($cursor: String) {
    products(first: 25, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        status
        variants(first: 20) { nodes { id sku } }
      }
    }
  }`;

const M_CRIAR = `
  mutation($input: ProductSetInput!) {
    productSet(synchronous: true, input: $input) {
      product { id variants(first: 1) { nodes { id sku } } }
      userErrors { field message }
    }
  }`;

const M_PRECO = `
  mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku price }
      userErrors { field message }
    }
  }`;

const M_STATUS = `
  mutation($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id status }
      userErrors { field message }
    }
  }`;

// Produto de variante única: o Shopify ainda exige a opção "Title"/"Default Title".
function inputCriacao(p) {
  return {
    title: p.titulo,
    status: 'DRAFT',                 // nunca publicamos: falta foto e descrição
    vendor: 'Gnatus',
    tags: ['protheus'],              // marca de procedência p/ a loja filtrar
    productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
    variants: [{
      sku: p.codigo,
      price: p.preco.toFixed(2),
      ...(p.ean ? { barcode: p.ean } : {}),
      optionValues: [{ optionName: 'Title', name: 'Default Title' }]
    }]
  };
}

async function criarProduto(p) {
  const d = await Api.gql(M_CRIAR, { input: inputCriacao(p) });
  Api.checarUserErrors(d?.productSet, `criar ${p.codigo}`);
  const prod = d?.productSet?.product;
  const variante = prod?.variants?.nodes?.[0];
  if (!prod?.id) throw new Error(`criar ${p.codigo}: Shopify não devolveu o produto`);
  return { productId: trim(prod.id), variantId: trim(variante?.id) };
}

// Procura uma variante pelo SKU na loja.
//
// Usado quando uma criação FALHA: o erro pode ter acontecido DEPOIS de o produto
// entrar na loja (timeout na resposta, queda de rede). Sem esta conferência a linha
// ficaria sem product_id, o ciclo seguinte tentaria criar de novo e a loja ficaria
// com o SKU duplicado — o Shopify não impõe unicidade de SKU.
const Q_POR_SKU = `
  query($q: String!) {
    productVariants(first: 2, query: $q) {
      nodes { id sku product { id } }
    }
  }`;

async function buscarPorSku(sku) {
  const d = await Api.gql(Q_POR_SKU, { q: `sku:"${String(sku).replace(/"/g, '')}"` });
  const achados = (d?.productVariants?.nodes || []).filter((v) => trim(v.sku) === trim(sku));
  if (!achados.length) return null;
  return {
    productId: trim(achados[0]?.product?.id),
    variantId: trim(achados[0].id),
    duplicado: achados.length > 1
  };
}

async function atualizarPreco(p, st) {
  if (!st.variantId) throw new Error(`preço ${p.codigo}: variante desconhecida (rode o SEED)`);
  const d = await Api.gql(M_PRECO, {
    productId: st.productId,
    variants: [{ id: st.variantId, price: p.preco.toFixed(2) }]
  });
  Api.checarUserErrors(d?.productVariantsBulkUpdate, `preço ${p.codigo}`);
}

async function arquivarProduto(codigo, productId) {
  const d = await Api.gql(M_STATUS, { input: { id: productId, status: 'ARCHIVED' } });
  Api.checarUserErrors(d?.productUpdate, `arquivar ${codigo}`);
}

// ---------------- Estado (Postgres) ----------------

async function carregarEstado(Pg) {
  const rows = await Pg.connectAndQuery(
    `SELECT codigo, product_id, variant_id, hash, status FROM tab_shopify_produto_sync`, {});
  const m = new Map();
  rows.forEach((r) => m.set(trim(r.codigo), {
    productId: trim(r.product_id), variantId: trim(r.variant_id),
    hash: trim(r.hash), status: trim(r.status)
  }));
  return m;
}

async function gravarEstado(Pg, codigo, productId, variantId, hash, status, erro = null) {
  await Pg.connectAndQuery(
    `INSERT INTO tab_shopify_produto_sync (codigo, product_id, variant_id, hash, status, erro, atualizado_em)
     VALUES (@c, @p, @v, @h, @s, @e, NOW())
     ON CONFLICT (codigo) DO UPDATE
        SET product_id = COALESCE(EXCLUDED.product_id, tab_shopify_produto_sync.product_id),
            variant_id = COALESCE(EXCLUDED.variant_id, tab_shopify_produto_sync.variant_id),
            hash = EXCLUDED.hash, status = EXCLUDED.status, erro = EXCLUDED.erro,
            atualizado_em = NOW()`,
    { c: codigo, p: productId || null, v: variantId || null, h: hash || null, s: status, e: erro });
}

async function marcarErro(Pg, codigo, msg) {
  try {
    await Pg.connectAndQuery(
      `INSERT INTO tab_shopify_produto_sync (codigo, status, erro, atualizado_em)
       VALUES (@c, 'erro', @e, NOW())
       ON CONFLICT (codigo) DO UPDATE SET status = 'erro', erro = EXCLUDED.erro, atualizado_em = NOW()`,
      { c: codigo, e: String(msg).slice(0, 400) });
  } catch (_) { /* best-effort */ }
}

async function usoHoje(Pg) {
  const r = await Pg.connectAndQuery(
    `SELECT COALESCE(gravacoes, 0)::int g FROM tab_shopify_ctrl WHERE dia = @d::date`, { d: hojeSP() });
  return Number(r[0]?.g || 0);
}

async function somarUso(Pg, n) {
  if (n <= 0) return;
  await Pg.connectAndQuery(
    `INSERT INTO tab_shopify_ctrl (dia, gravacoes) VALUES (@d::date, @n)
     ON CONFLICT (dia) DO UPDATE SET gravacoes = tab_shopify_ctrl.gravacoes + EXCLUDED.gravacoes`,
    { d: hojeSP(), n });
}

async function logar(Pg, r) {
  try {
    await Pg.connectAndQuery(
      `INSERT INTO tab_shopify_log (origem, catalogo, criados, atualizados, arquivados, erros, simulado, detalhe)
       VALUES (@o, @cat, @c, @a, @arq, @e, @sim, @d)`,
      { o: r.origem, cat: r.elegiveis, c: r.criados, a: r.atualizados, arq: r.arquivados,
        e: r.erros, sim: !!r.simulado, d: r.detalhes.slice(0, 25).join(' | ').slice(0, 1900) });
  } catch (e) { console.warn('[shopify] log:', e.message); }
}

// ---------------- SEED (uma vez, antes do primeiro ciclo) ----------------
// Pagina os produtos que já existem na loja e casa pelo SKU da variante. Sem isso o
// primeiro ciclo recriaria como duplicata tudo que já foi cadastrado à mão.
// SKU na loja que não está no catálogo da ACV vira 'orfao' e é deixado em paz.
async function seed({ Pg, Protheus }) {
  const resumo = { origem: 'SEED', produtosLoja: 0, comSku: 0, casados: 0, orfaos: 0, semSku: 0 };
  if (!Api.configurado()) { resumo.erro = 'SHOPIFY_SHOP/SHOPIFY_TOKEN ausentes'; return resumo; }

  const catalogo = await Catalogo.carregar(Protheus);
  // Pertence ao NOSSO catálogo = está na ACV, elegível ou não. Um SKU que está na
  // ACV mas hoje está sem preço/bloqueado NÃO pode virar 'orfao': 'orfao' significa
  // "é da loja, não é nosso" e o ciclo o ignora para sempre — o produto ficaria
  // congelado quando o cadastro do Protheus fosse corrigido.
  const nossos = new Set(catalogo.map((p) => p.codigo));

  let cursor = null;
  do {
    const d = await Api.gql(Q_PRODUTOS, { cursor });
    for (const node of (d?.products?.nodes || [])) {
      resumo.produtosLoja++;
      const variantes = node?.variants?.nodes || [];
      const comSku = variantes.filter((v) => trim(v.sku));
      if (!comSku.length) { resumo.semSku++; continue; }

      for (const v of comSku) {
        const sku = trim(v.sku);
        resumo.comSku++;
        const meu = nossos.has(sku);
        if (meu) resumo.casados++; else resumo.orfaos++;
        // hash NULL de propósito: não sabemos com que preço o produto está na loja.
        // Gravar o hash do Protheus aqui declararia "já sincronizado" e congelaria
        // uma eventual divergência de preço para sempre. Com NULL, o primeiro ciclo
        // publica o preço correto.
        await gravarEstado(Pg, sku, trim(node.id), trim(v.id), null, meu ? 'seed' : 'orfao');
      }
    }
    cursor = d?.products?.pageInfo?.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (cursor);

  // Marco de SEED CONCLUÍDO. É esta linha — e não a contagem de registros — que
  // destrava o sincronizar(): numa loja vazia o seed grava 0 linhas e a contagem
  // deixaria o espelho travado para sempre em "seed pendente". Só é gravada quando
  // a paginação termina inteira, então um seed interrompido continua pendente.
  await Pg.connectAndQuery(
    `INSERT INTO tab_shopify_log (origem, catalogo, detalhe) VALUES ('SEED', @cat, @d)`,
    { cat: catalogo.length,
      d: `produtosLoja=${resumo.produtosLoja} comSku=${resumo.comSku} casados=${resumo.casados} orfaos=${resumo.orfaos} semSku=${resumo.semSku}` }
  );

  console.log('[shopify] seed:', JSON.stringify(resumo));
  return resumo;
}

// Seed concluído? Lê o marco no log, não a contagem de linhas de estado.
async function seedFeito(Pg) {
  const r = await Pg.connectAndQuery(
    `SELECT COUNT(*)::int n FROM tab_shopify_log WHERE origem = 'SEED'`, {});
  return Number(r[0]?.n || 0) > 0;
}

// ---------------- Sincronização (delta, represada pelo teto) ----------------
async function sincronizar({ Pg, Protheus }, origem = 'CRON') {
  const resumo = {
    origem, simulado: SIMULAR(), catalogo: 0, elegiveis: 0, inelegiveis: 0,
    criados: 0, atualizados: 0, arquivados: 0, adotados: 0, recuperados: 0,
    semMudanca: 0, erros: 0, aCriar: 0, aAtualizar: 0, puladosCap: 0,
    teto: TETO_DIA(), usoHoje: 0, detalhes: []
  };

  if (!disponivel()) {
    resumo.detalhes.push('inativo (defina SHOPIFY_SHOP, SHOPIFY_TOKEN e SHOPIFY_ATIVO=1)');
    return resumo;
  }

  // Trava de concorrência: o cron de hora em hora e o botão "rodar agora" da tela
  // podem cair no mesmo instante. Sem isto, dois ciclos leem o mesmo estado (sem
  // product_id), criam o MESMO SKU e a loja fica com o produto duplicado — o
  // Shopify não impõe SKU único.
  if (emExecucao) {
    resumo.detalhes.push('já existe um ciclo em andamento — ignorado.');
    return resumo;
  }
  emExecucao = true;
  try {
    return await executarCiclo({ Pg, Protheus }, origem, resumo);
  } finally {
    emExecucao = false;
  }
}

async function executarCiclo({ Pg, Protheus }, origem, resumo) {

  // Trava anti-duplicata: sem SEED não sabemos o que já existe na loja.
  // Checa o MARCO de seed, não a contagem de linhas — numa loja vazia o seed grava
  // 0 linhas e a contagem travaria o espelho para sempre.
  if (!(await seedFeito(Pg))) {
    resumo.seedPendente = true;
    resumo.detalhes.push('SEED não concluído — rode o SEED antes (evita criar produto duplicado na loja).');
    await logar(Pg, resumo);
    return resumo;
  }

  resumo.usoHoje = await usoHoje(Pg);
  const orcamento = Math.min(TETO_CICLO(), Math.max(0, TETO_DIA() - resumo.usoHoje));
  if (orcamento <= 0 && !SIMULAR()) {
    resumo.detalhes.push(`teto diário atingido (${TETO_DIA()} gravações) — retoma amanhã.`);
    await logar(Pg, resumo);
    return resumo;
  }

  const catalogo = await Catalogo.carregar(Protheus);
  const elegiveis = Catalogo.elegiveis(catalogo);
  resumo.catalogo = catalogo.length;
  resumo.elegiveis = elegiveis.length;
  resumo.inelegiveis = catalogo.length - elegiveis.length;

  if (!catalogo.length) {
    resumo.detalhes.push('ACU/ACV sem cadastro no Protheus — nada a espelhar.');
    await logar(Pg, resumo);
    return resumo;
  }

  const estado = await carregarEstado(Pg);

  const toCreate = [];
  const toUpdate = [];
  for (const p of elegiveis) {
    const st = estado.get(p.codigo);
    if (!st || !st.productId) { toCreate.push(p); continue; }
    // 'orfao' = estava na loja e fora do nosso catálogo no seed. Se entrou na ACV
    // depois, ADOTAMOS: o SKU é a identidade e o produto agora é nosso. Sem isso o
    // 'orfao' era estado absorvente e o produto ficava congelado para sempre.
    if (st.status === 'orfao') resumo.adotados++;
    if (st.hash !== p.hash) toUpdate.push({ p, st });
    else resumo.semMudanca++;
  }
  resumo.aCriar = toCreate.length;
  resumo.aAtualizar = toUpdate.length;

  // Arquivamento: quem tem produto na loja pelo espelho e saiu do filtro (ou virou
  // inelegível). Desligado por padrão — o primeiro go-live é puramente aditivo.
  const toArchive = [];
  if (ARQUIVAR()) {
    const vivos = new Set(elegiveis.map((p) => p.codigo));
    for (const [codigo, st] of estado) {
      if (st.status === 'orfao' || st.status === 'arquivado') continue;
      if (st.productId && !vivos.has(codigo)) toArchive.push({ codigo, st });
    }
  }

  // Dry-run: nada é enviado. Serve para conferir o plano do ciclo antes de ligar.
  if (SIMULAR()) {
    resumo.detalhes.push(`SIMULAÇÃO — criaria ${toCreate.length}, atualizaria ${toUpdate.length}, arquivaria ${toArchive.length}. Nenhuma chamada à API.`);
    toCreate.slice(0, 5).forEach((p) => resumo.detalhes.push(`criaria ${p.codigo} "${p.titulo}" R$ ${p.preco.toFixed(2)}`));
    toUpdate.slice(0, 5).forEach((u) => resumo.detalhes.push(`atualizaria preço ${u.p.codigo} -> R$ ${u.p.preco.toFixed(2)}`));
    await logar(Pg, resumo);
    console.log(`[shopify] ${origem} (SIMULADO): catalogo=${resumo.catalogo} elegiveis=${resumo.elegiveis} criaria=${toCreate.length} atualizaria=${toUpdate.length} arquivaria=${toArchive.length}`);
    return resumo;
  }

  let gravou = 0;

  // ⚠️ O orçamento conta TENTATIVAS, não sucessos. Contando só sucesso, uma falha
  // sistêmica (token revogado, loja fora do ar) não consumia teto nenhum e o ciclo
  // varria os ~1.900 itens disparando chamada atrás de chamada, sem freio.
  // Um surto de erros também aborta o ciclo: erro em sequência é sinal de problema
  // de ambiente, não de produto.
  const LIMITE_ERROS_SEGUIDOS = 10;
  let errosSeguidos = 0;
  let abortado = false;

  const tentar = async (rotulo, codigo, fn) => {
    if (abortado || gravou >= orcamento) { resumo.puladosCap++; return false; }
    gravou++;                                   // a tentativa já consome o teto
    try {
      await fn();
      errosSeguidos = 0;
      return true;
    } catch (e) {
      resumo.erros++;
      resumo.detalhes.push(`${rotulo} ${codigo}: ${e.message}`);
      await marcarErro(Pg, codigo, e.message);
      if (++errosSeguidos >= LIMITE_ERROS_SEGUIDOS) {
        abortado = true;
        resumo.abortado = true;
        resumo.detalhes.push(`ABORTADO: ${LIMITE_ERROS_SEGUIDOS} erros seguidos — provável problema de credencial ou da loja, não dos produtos.`);
      }
      return false;
    }
  };

  for (const p of toCreate) {
    await tentar('cria', p.codigo, async () => {
      let productId, variantId;
      try {
        ({ productId, variantId } = await criarProduto(p));
      } catch (e) {
        // A falha pode ter vindo DEPOIS de o produto entrar na loja. Confere antes
        // de desistir: se já está lá, registra em vez de recriar no próximo ciclo.
        const achado = await buscarPorSku(p.codigo).catch(() => null);
        if (!achado) throw e;
        await gravarEstado(Pg, p.codigo, achado.productId, achado.variantId, p.hash, 'ok');
        resumo.recuperados++;
        resumo.detalhes.push(`recuperado ${p.codigo}: a criação falhou mas o produto existe na loja${achado.duplicado ? ' (⚠️ SKU duplicado na loja)' : ''}`);
        return;
      }
      await gravarEstado(Pg, p.codigo, productId, variantId, p.hash, 'ok');
      resumo.criados++;
    });
  }

  for (const u of toUpdate) {
    await tentar('preço', u.p.codigo, async () => {
      await atualizarPreco(u.p, u.st);
      await gravarEstado(Pg, u.p.codigo, u.st.productId, u.st.variantId, u.p.hash, 'ok');
      resumo.atualizados++;
    });
  }

  for (const a of toArchive) {
    await tentar('arquiva', a.codigo, async () => {
      await arquivarProduto(a.codigo, a.st.productId);
      await gravarEstado(Pg, a.codigo, a.st.productId, a.st.variantId, a.st.hash, 'arquivado');
      resumo.arquivados++;
    });
  }

  await somarUso(Pg, gravou);
  await logar(Pg, resumo);
  console.log(`[shopify] ${origem}: catalogo=${resumo.catalogo} elegiveis=${resumo.elegiveis} criados=${resumo.criados} atualizados=${resumo.atualizados} arquivados=${resumo.arquivados} erros=${resumo.erros} puladosCap=${resumo.puladosCap} (uso dia ${resumo.usoHoje + gravou}/${TETO_DIA()})`);
  return resumo;
}

// ---------------- Panorama p/ a tela ----------------
async function panorama({ Pg, Protheus }) {
  const diag = await Catalogo.diagnostico(Protheus);
  const catalogo = await Catalogo.carregar(Protheus);
  const elegiveis = Catalogo.elegiveis(catalogo);

  const st = (await Pg.connectAndQuery(
    `SELECT
       -- 'arquivado' fica FORA de sincronizados: senão o mesmo produto aparecia
       -- somado em "Já na loja" e em "Arquivados" na tela.
       COUNT(*) FILTER (WHERE product_id IS NOT NULL AND status NOT IN ('orfao','erro','arquivado'))::int sincronizados,
       COUNT(*) FILTER (WHERE status = 'orfao')::int orfaos,
       COUNT(*) FILTER (WHERE status = 'arquivado')::int arquivados,
       COUNT(*) FILTER (WHERE status = 'erro')::int erros,
       COUNT(*)::int total
     FROM tab_shopify_produto_sync`, {}))[0] || {};

  const sincronizados = Number(st.sincronizados || 0);

  // Pré-voo da credencial: confirma que o token abre a loja e diz qual é a MOEDA
  // dela antes de alguém mandar ~1.900 preços. Falha aqui não derruba a tela — ela
  // mostra o motivo, que é justamente o que se quer ver quando o token é revogado.
  let loja = null;
  let erroCredencial = null;
  if (Api.configurado()) {
    try { loja = await Api.verificarAcesso(); }
    catch (e) { erroCredencial = e.message; }
  }

  return {
    configurado: Api.configurado(),
    loja_nome: loja ? loja.nome : null,
    loja_moeda: loja ? loja.moeda : null,
    erroCredencial,
    ativo: disponivel(),
    simular: SIMULAR(),
    arquivar: ARQUIVAR(),
    loja: Api.SHOP(),
    versaoApi: Api.VERSAO(),
    tabelaPreco: diag.tabelaPreco,
    tetoDia: TETO_DIA(),
    tetoCiclo: TETO_CICLO(),
    usoHoje: await usoHoje(Pg),
    seedFeito: await seedFeito(Pg),
    protheus: diag,
    totais: {
      catalogo: catalogo.length,
      elegiveis: elegiveis.length,
      inelegiveis: catalogo.length - elegiveis.length,
      sincronizados,
      faltando: Math.max(0, elegiveis.length - sincronizados),
      orfaos: Number(st.orfaos || 0),
      arquivados: Number(st.arquivados || 0),
      erros: Number(st.erros || 0)
    }
  };
}

async function ultimosLogs(Pg, limite = 15) {
  return Pg.connectAndQuery(
    `SELECT origem, catalogo, criados, atualizados, arquivados, erros, simulado, detalhe,
            TO_CHAR(criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') quando
       FROM tab_shopify_log ORDER BY criado_em DESC LIMIT @lim`, { lim: limite });
}

module.exports = { disponivel, seed, sincronizar, panorama, ultimosLogs, SIMULAR, ARQUIVAR };

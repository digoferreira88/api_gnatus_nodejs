// services/painelEstoqueCompras.js — monta o objeto DATA do Painel de Estoque (Compras).
//
// O painel foi construído pelo setor de Compras como HTML único alimentado por três
// uploads diários (posição de estoque, pedidos de compra, carteira). Este serviço
// produz o MESMO objeto `DATA` a partir do Protheus, para aposentar os uploads.
// Contrato e regras: docs/compras/Painel_Estoque_GNATUS_Contexto.md (seção 6).
//
// DATA = {
//   historico: [{ ym, ano, mes, wh: { armazem: [valorEstoque, valorEmpenho] } }]
//   stock:    [[produto, descricao, armazem, saldoAtual, saldoDisp, valorEstoque, valorEmpenho]]
//   poRaw:    [[codigo, descProduto, abertoQtd, dataPrevISO]]      — nível de LINHA
//   cartRaw:  [[codigo, descricao, saldoQtd, dataEntregaISO]]      — nível de LINHA
//   struct:   { codigo: 1|2 }          1 = é pai/PA na estrutura · 2 = é componente
//   compRoot: { componente: PA }       componente que pertence a UM ÚNICO PA de topo
//   tipoMap:  { codigo: TP }           tipo do produto (SB1.B1_TIPO)
//   ref:      { carteira, hoje }
// }
//
// O painel agrega: soma PC por item, pega a menor data prevista, divide a carteira em
// atrasada/futura pelo mês vigente e calcula disponibilidade. Nada disso é feito aqui —
// mandar nível de linha preserva o corte dinâmico da carteira (regra R5 do contexto).

const Carteira = require('./carteiraRegras');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const n2 = (v) => Math.round(N(v) * 100) / 100;

// Só armazém cadastrado (NNR010, 36 deles). O SB2 guarda códigos de digitação errada
// ("8/", ",,", "1"), todos zerados, que o relatório do ERP também não traz — e foi essa
// a diferença entre os 72 códigos do SB2 e os 35 do painel de Compras.
const FILTRO_ARMAZEM = `EXISTS (SELECT 1 FROM NNR010 nnr WITH (NOLOCK)
      WHERE nnr.D_E_L_E_T_ <> '*' AND RTRIM(nnr.NNR_CODIGO) = RTRIM(b2.B2_LOCAL))`;

const CACHE_MS = () => Math.max(1, Number(process.env.PAINEL_ESTOQUE_TTL_MIN || 10)) * 60e3;
let cache = null;   // { em, dados }
const limparCache = () => { cache = null; };

const isoDeProtheus = (d) => (/^\d{8}$/.test(trim(d)) ? `${trim(d).slice(0, 4)}-${trim(d).slice(4, 6)}-${trim(d).slice(6, 8)}` : null);
const hojeBrasilia = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

// ---------------------------------------------------------------------------
// Protheus
// ---------------------------------------------------------------------------

// Posição atual por (item, armazém). Disponível = saldo - empenho - reserva (fórmula
// padrão do ERP); valor de empenho = quantidade empenhada × custo médio.
async function lerEstoque(Protheus) {
  return Protheus.connectAndQuery(`
    SELECT RTRIM(b2.B2_COD) cod, RTRIM(b1.B1_DESC) descricao, RTRIM(b2.B2_LOCAL) armazem,
           b2.B2_QATU saldoAtual,
           (b2.B2_QATU - b2.B2_QEMP - b2.B2_RESERVA) saldoDisp,
           b2.B2_VATU1 valorEstoque,
           (b2.B2_QEMP * b2.B2_CM1) valorEmpenho
      FROM SB2010 b2 WITH (NOLOCK)
      LEFT JOIN SB1010 b1 WITH (NOLOCK) ON b1.B1_COD = b2.B2_COD AND b1.D_E_L_E_T_ <> '*'
     WHERE b2.D_E_L_E_T_ <> '*' AND b2.B2_FILIAL = '01' AND ${FILTRO_ARMAZEM}`, {});
}

// Pedidos de compra em aberto, nível de linha (regra R1: exclui resíduo eliminado e
// mantém só o que falta receber).
async function lerPedidosCompra(Protheus) {
  return Protheus.connectAndQuery(`
    SELECT RTRIM(C7_PRODUTO) cod, RTRIM(C7_DESCRI) descricao,
           (C7_QUANT - C7_QUJE) aberto, C7_DATPRF dataPrev
      FROM SC7010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*' AND C7_FILIAL = '01'
       AND RTRIM(C7_RESIDUO) <> 'S' AND (C7_QUANT - C7_QUJE) > 0`, {});
}

// Carteira de pedidos, nível de linha — MESMA regra do export .xlsx da tela de
// Carteira (resources/vendas/vendas.carteira-detalhe.js), que é justamente o arquivo
// que Compras subia no painel. Regra compartilhada em services/carteiraRegras.js.
async function lerCarteira(Protheus) {
  return Protheus.connectAndQuery(`
    SELECT RTRIM(c6.C6_PRODUTO) cod, RTRIM(c6.C6_DESCRI) descricao,
           (c6.C6_QTDVEN - c6.C6_QTDENT) saldo, c6.C6_ENTREG dataEntrega
      FROM SC6010 c6 WITH (NOLOCK)
      JOIN SC5010 c5 WITH (NOLOCK) ON c5.C5_NUM = c6.C6_NUM AND c5.C5_FILIAL = '01' AND c5.D_E_L_E_T_ <> '*'
      JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = c5.C5_CLIENTE AND sa1.A1_LOJA = c5.C5_LOJACLI AND sa1.D_E_L_E_T_ <> '*'
      JOIN SB1010 sb1 WITH (NOLOCK) ON sb1.B1_FILIAL = '' AND sb1.B1_COD = c6.C6_PRODUTO AND sb1.D_E_L_E_T_ <> '*'
     WHERE c6.D_E_L_E_T_ <> '*' AND c6.C6_FILIAL = '01' AND ${Carteira.filtroSql('c6')}`, {});
}

async function lerEstrutura(Protheus) {
  return Protheus.connectAndQuery(`
    SELECT RTRIM(G1_COD) pai, RTRIM(G1_COMP) componente
      FROM SG1010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*' AND RTRIM(G1_COMP) <> '' AND RTRIM(G1_COD) <> ''
     GROUP BY G1_COD, G1_COMP`, {});
}

// B1_TIPO tem cadastro em minúsculo em alguns itens ("mp"); o painel usa o valor como
// rótulo do filtro, então normaliza para não aparecer chip repetido.
async function lerTipos(Protheus) {
  return Protheus.connectAndQuery(`
    SELECT RTRIM(B1_COD) cod, UPPER(RTRIM(B1_TIPO)) tipo
      FROM SB1010 WITH (NOLOCK) WHERE D_E_L_E_T_ <> '*' AND RTRIM(B1_TIPO) <> ''`, {});
}

// Armazéns cadastrados — o histórico mensal foi gravado antes deste filtro existir e
// carrega códigos de digitação errada que virariam chip na tela.
async function lerArmazensValidos(Protheus) {
  const r = await Protheus.connectAndQuery(`
    SELECT RTRIM(NNR_CODIGO) cod FROM NNR010 WITH (NOLOCK) WHERE D_E_L_E_T_ <> '*'`, {});
  return new Set(r.map(x => trim(x.cod)));
}

// Série do gráfico: fechamento mensal por armazém (tab_estoque_snapshot_mensal, job
// das 03:00). valor_empenho passou a ser gravado em 22/09/2026; meses anteriores vêm
// com 0 até a carga do histórico que o setor mantém em planilha.
async function lerHistorico(Pg) {
  return Pg.connectAndQuery(`
    SELECT ano_mes, armazem,
           SUM(valor_estoque)::float valor_estoque,
           SUM(COALESCE(valor_empenho, 0))::float valor_empenho
      FROM tab_estoque_snapshot_mensal
     GROUP BY ano_mes, armazem
     ORDER BY ano_mes`, {});
}

// ---------------------------------------------------------------------------
// Estrutura de produto: struct e compRoot (regras R8 e R11)
// ---------------------------------------------------------------------------
// compRoot leva a compra do componente até o código de venda. Sobe pai→pai; o
// componente só entra se alcançar EXATAMENTE um PA de topo (sem ambiguidade).
function montarEstrutura(arestas) {
  const paisDe = new Map();      // componente -> Set(pais)
  const ehPai = new Set();
  const ehComponente = new Set();
  arestas.forEach(a => {
    const pai = trim(a.pai), comp = trim(a.componente);
    if (!pai || !comp) return;
    ehPai.add(pai); ehComponente.add(comp);
    if (!paisDe.has(comp)) paisDe.set(comp, new Set());
    paisDe.get(comp).add(pai);
  });

  const struct = {};
  ehPai.forEach(c => { struct[c] = 1; });
  ehComponente.forEach(c => { if (!struct[c]) struct[c] = 2; });

  const topos = (codigo) => {
    const achados = new Set();
    const vistos = new Set([codigo]);
    const fila = [codigo];
    while (fila.length) {
      const atual = fila.shift();
      const pais = paisDe.get(atual);
      if (!pais || !pais.size) {
        if (atual !== codigo) achados.add(atual);   // chegou ao topo
        continue;
      }
      pais.forEach(p => { if (!vistos.has(p)) { vistos.add(p); fila.push(p); } });
      if (achados.size > 1) break;                  // já é ambíguo
    }
    return achados;
  };

  const compRoot = {};
  ehComponente.forEach(comp => {
    const t = topos(comp);
    if (t.size === 1) compRoot[comp] = [...t][0];
  });
  return { struct, compRoot };
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------
async function montarDados(app, { semCache = false } = {}) {
  if (!semCache && cache && Date.now() - cache.em < CACHE_MS()) return cache.dados;
  const { Protheus, Pg } = app.services;

  const t0 = Date.now();
  const [estoque, pc, carteira, arestas, tipos, historicoRows, armazens] = await Promise.all([
    lerEstoque(Protheus), lerPedidosCompra(Protheus), lerCarteira(Protheus),
    lerEstrutura(Protheus), lerTipos(Protheus), lerHistorico(Pg), lerArmazensValidos(Protheus)
  ]);

  const stock = estoque.map(r => [
    trim(r.cod), trim(r.descricao), trim(r.armazem),
    n2(r.saldoAtual), n2(r.saldoDisp), n2(r.valorEstoque), n2(r.valorEmpenho)
  ]);
  const poRaw = pc.map(r => [trim(r.cod), trim(r.descricao), n2(r.aberto), isoDeProtheus(r.dataPrev)]);
  const cartRaw = carteira.map(r => [trim(r.cod), trim(r.descricao), n2(r.saldo), isoDeProtheus(r.dataEntrega)]);

  const { struct, compRoot } = montarEstrutura(arestas);
  // Só os códigos que aparecem no painel (o SB1 tem 17 mil itens; mandar todos
  // engordaria a resposta em ~400 KB sem serventia).
  const usados = new Set([...stock.map(r => r[0]), ...poRaw.map(r => r[0]), ...cartRaw.map(r => r[0]), ...Object.keys(compRoot)]);
  const tipoMap = {};
  tipos.forEach(r => { const c = trim(r.cod); if (usados.has(c)) tipoMap[c] = trim(r.tipo); });

  // histórico -> 1 objeto por mês, com os armazéns dentro
  const porMes = new Map();
  historicoRows.forEach(r => {
    const am = trim(r.ano_mes);
    if (!/^\d{6}$/.test(am) || !armazens.has(trim(r.armazem))) return;
    const ym = `${am.slice(0, 4)}-${am.slice(4, 6)}`;
    if (!porMes.has(ym)) porMes.set(ym, { ym, ano: Number(am.slice(0, 4)), mes: Number(am.slice(4, 6)), wh: {} });
    porMes.get(ym).wh[trim(r.armazem)] = [n2(r.valor_estoque), n2(r.valor_empenho)];
  });
  const historico = [...porMes.values()].sort((a, b) => a.ym.localeCompare(b.ym));

  const hoje = hojeBrasilia();
  const dados = {
    historico, stock, poRaw, cartRaw, struct, compRoot, tipoMap,
    ref: { carteira: hoje, hoje },
    // Diagnóstico do ETL — o painel ignora, mas a tela mostra a hora da leitura.
    _meta: {
      geradoEm: new Date().toISOString(),
      ms: Date.now() - t0,
      linhas: { stock: stock.length, poRaw: poRaw.length, cartRaw: cartRaw.length, historico: historico.length },
      itens: { stock: new Set(stock.map(r => r[0])).size, struct: Object.keys(struct).length, compRoot: Object.keys(compRoot).length }
    }
  };
  cache = { em: Date.now(), dados };
  return dados;
}

module.exports = { montarDados, limparCache, montarEstrutura };

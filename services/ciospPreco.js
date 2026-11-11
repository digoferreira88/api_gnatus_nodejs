// services/ciospPreco.js — regra de preço do CIOSP (spec 2026-11-11, seção 5).
//
// Cada linha da Tabela Comercial tem 4 preços: tabela 13% ou 11% (é a comissão do
// vendedor, ele escolhe) × coluna "10x no cartão ou 10% no Pix" ou "6x no cartão ou
// 6% no Pix". A forma de pagamento diz qual coluna vale e se há desconto sobre ela.
//
// Toda conta é feita em CENTAVOS INTEIROS, com arredondamento de meio centavo para
// cima: 484,95 × 0,90 = 436,455 vira 436,46. Em ponto flutuante a mesma conta dá
// 436,45, e a diferença aparece no orçamento impresso.
//
// Este arquivo é usado pela API e espelhado no app do estande (que calcula offline);
// o servidor sempre recalcula.

const crypto = require('crypto');

const TABELAS = new Set(['13', '11']);
const COLUNAS = new Set(['10x', '6x']);

// Aceita Number (célula numérica do Excel) e texto "R$ 1.234,56", "1.234,56",
// "1234.56" ou "1,234.56". Devolve centavos inteiros, ou NaN se não for número.
function paraCentavos(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : NaN;
  let s = String(v).replace(/R\$/gi, '').replace(/\s/g, '');
  if (!s) return NaN;
  const ultVirg = s.lastIndexOf(',');
  const ultPonto = s.lastIndexOf('.');
  if (ultVirg >= 0 && ultPonto >= 0) {
    // os dois aparecem: o último é o separador decimal
    s = ultVirg > ultPonto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (ultVirg >= 0) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (ultPonto >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    // "1.234" ou "1.234.567": ponto de milhar
    s = s.replace(/\./g, '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

const reais = (centavos) => centavos / 100;

// Percentual com até 2 casas vira inteiro (×100) para não reintroduzir ponto flutuante.
const pctInteiro = (pct) => Math.round((Number(pct) || 0) * 100);
const aplicarDesconto = (centavos, pct) => Math.round((centavos * (10000 - pctInteiro(pct))) / 10000);

function centavosDaColuna(linha, tabela, coluna) {
  const t = String(tabela);
  if (!TABELAS.has(t)) throw new Error(`Tabela inválida: ${tabela} (use 13 ou 11).`);
  if (!COLUNAS.has(coluna)) throw new Error(`Coluna inválida: ${coluna} (use 10x ou 6x).`);
  const c = paraCentavos(linha[`preco_${t}_${coluna}`]);
  if (Number.isNaN(c)) throw new Error(`Linha sem preço na tabela ${t}% ${coluna}.`);
  return c;
}

function centavosBase(linha, tabela, forma) {
  return aplicarDesconto(centavosDaColuna(linha, tabela, forma.coluna_base), forma.desconto_pct);
}

function precoBase(linha, tabela, forma) {
  return reais(centavosBase(linha, tabela, forma));
}

function descontoLivrePct(linha, config) {
  return (Number(linha.promocao_pct) || 0) + (Number(config.desconto_livre_pct) || 0);
}

function centavosMinimo(linha, tabela, forma, config) {
  return aplicarDesconto(centavosBase(linha, tabela, forma), descontoLivrePct(linha, config));
}

function precoMinimo(linha, tabela, forma, config) {
  return reais(centavosMinimo(linha, tabela, forma, config));
}

function exigeAprovacao(itens, tabela, forma, config) {
  return (itens || []).some(({ linha, preco }) =>
    paraCentavos(preco) < centavosMinimo(linha, tabela, forma, config));
}

// A aprovação do gerente vale para estes preços exatos: mudou item, quantidade, preço,
// tabela ou forma, o hash muda e a aprovação deixa de valer.
function hashAprovacao({ itens, tabela, forma_id }) {
  const canon = {
    t: String(tabela),
    f: forma_id == null ? null : Number(forma_id),
    i: [...(itens || [])]
      .map(it => [Number(it.preco_id), Number(it.quantidade), paraCentavos(it.preco)])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

module.exports = {
  paraCentavos, precoBase, descontoLivrePct, precoMinimo, exigeAprovacao, hashAprovacao
};

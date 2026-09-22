// services/carteiraRegras.js — o que é "carteira de pedidos" na intranet.
//
// Existe um lugar só para esta regra porque ela alimenta dois consumidores que
// PRECISAM bater entre si:
//   - resources/vendas/vendas.carteira-detalhe.js  (export .xlsx da tela de Carteira)
//   - services/painelEstoqueCompras.js             (Painel de Estoque do Compras)
//
// Descoberto em 22/09/2026: o arquivo que Compras subia todo dia no painel era o
// próprio export .xlsx da intranet (as colunas batem: Data Entrega na D, Código na Y,
// Descrição na Z, Saldo na AD). Enquanto o painel usava outra regra, ele mostrava
// 4.573 linhas onde o export mostrava 3.416 — item bloqueado e CFOP fora da carteira
// entravam na conta.

// CFOPs que compõem a carteira (venda, remessa de entrega futura, venda à ordem,
// remessa de conserto). CFOP fora desta lista não é carteira a entregar.
const CFOPS_CARTEIRA = [
  '5105', '5106', '5116', '5117', '5119', '5405', '5933', '5924',
  '6105', '6106', '6107', '6108', '6110', '6116', '6117', '6119', '6122', '6123', '6404', '6933'
];

const listaSql = () => CFOPS_CARTEIRA.map(c => `'${c}'`).join(',');

// Condições da carteira em aberto, para colar no WHERE. `c6` é o alias da SC6010.
//   - saldo a entregar > 0
//   - C6_BLQ em BRANCO: item bloqueado ou com resíduo eliminado ('R') está fora
//   - CFOP na lista acima
const filtroSql = (c6 = 'c6') =>
  `(${c6}.C6_QTDVEN - ${c6}.C6_QTDENT) > 0 AND ${c6}.C6_BLQ = ' ' AND ${c6}.C6_CF IN (${listaSql()})`;

module.exports = { CFOPS_CARTEIRA, listaSql, filtroSql };

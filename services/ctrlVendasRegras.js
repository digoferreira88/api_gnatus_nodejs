// services/ctrlVendasRegras.js — regras de negócio do relatório de vendas da
// Controladoria, revertidas do pivô TD-GERAL da planilha (batem EXATO com 2023/2024;
// 2022/2025 ~0,1% = cache antigo da dinâmica). Fonte única p/ reconciliação + dashboard.

// "Tipo a considerar" que NÃO contam como venda (saem do CONSIDERADO no relatório Geral).
const FORA = ['Pedido Devolvido', 'Desconsiderar', 'Garantia/Troca', 'Franquias Taxas', 'Redigitação'];

// Segmentos apresentados (Geral/Digital/Varejo). O filtro é por "tipo_considerar".
// geral = tudo menos FORA. digital/varejo = recorte específico (a refinar vs TD-DIGITAL/VAREJO).
const SEGMENTOS = {
  geral:   { label: 'Geral',   incluir: null,                  excluir: FORA },   // tudo exceto FORA
  digital: { label: 'Digital', incluir: ['Digital', 'Online'], excluir: null },
  varejo:  { label: 'Varejo',  incluir: ['Comercial Varejo'],  excluir: null }
};

module.exports = { FORA, SEGMENTOS };

// services/vendasEstatus.js — mapeia o estágio do pedido de venda da view
// `pedidos_estatus` do Protheus (mesma fonte usada no módulo de Planejamento)
// para { cod, label, cor }. O label preserva o texto do campo `estatus`.
//
// Fluxo de liberação (estatus_cod):
//   10 Comercial → 20 Financeiro → 30 Planejamento → 40 Formulação Financeira
//   → 50 Estoque → 60 Faturamento → 99 Totalmente Faturado  (0 = Desconhecido)
// Para o status do PEDIDO usa-se o menor cod entre os itens (o "gargalo" atual).

const ESTATUS = {
  0:  { label: 'Desconhecido',                            cor: '#6b7a90' },
  10: { label: '10 Aguardando liberação do Comercial',    cor: '#b8860b' },
  20: { label: '20 Aguardando liberação do Financeiro',   cor: '#c0392b' },
  30: { label: '30 Aguardando Liberação de Planejamento', cor: '#e07b00' },
  40: { label: '40 Aguardando Formulação Financeira',     cor: '#e07b00' },
  50: { label: '50 Aguardando Liberação de Estoque',      cor: '#e07b00' },
  60: { label: '60 Aguardando Faturamento',               cor: '#1e5fb5' },
  99: { label: '99 Totalmente Faturado',                  cor: '#1e7d4f' }
};

function info(cod) {
  const n = Number(cod);
  if (Number.isFinite(n) && ESTATUS[n]) return { cod: n, label: ESTATUS[n].label, cor: ESTATUS[n].cor };
  return { cod: (cod == null ? null : n), label: 'Sem situação', cor: '#6b7a90' };
}

module.exports = { info, ESTATUS };

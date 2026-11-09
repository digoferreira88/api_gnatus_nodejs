// services/cobrancaStatus.js — fonte ÚNICA dos status de cobrança (valor + rótulo).
//
// Dois níveis (09/11/2026):
//   - CLIENTE: RECUPERAVEL / NAO_RECUPERAVEL / JURIDICO (STATUS_CLIENTE_LIST),
//     escolha da equipe, sem vínculo com os títulos. Jurídico segue também como
//     sub-status de título.
//   - TÍTULO (sub-status): a lista STATUS_LIST abaixo. É ela que o filtro
//     escondido do dashboard usa (config + validação).
// Valores antigos de status do CLIENTE (Em cobrança, Recompra…) continuam gravados
// até a equipe reclassificar o cliente — rótulo em LABELS para exibir. Depois da
// reclassificação, serão removidos (decisão do usuário, 09/11).

const STATUS_CLIENTE_LIST = [
  { value: 'RECUPERAVEL',     label: 'Recuperável' },
  { value: 'NAO_RECUPERAVEL', label: 'Não recuperável' },
  { value: 'JURIDICO',        label: 'Jurídico' }
];

const STATUS_LIST = [
  { value: 'SOLICITACAO_BAIXA_CR', label: 'Solicitação de baixa CR' },
  { value: 'RECOMPRA',            label: 'Recompra' },
  { value: 'NEGOCIANDO',          label: 'Em cobrança' },
  { value: 'PROMESSA',            label: 'Promessa' },
  { value: 'ACORDO_EM_ANDAMENTO', label: 'Acordo em andamento' },
  { value: 'ACORDO_QUEBRADO',     label: 'Acordo quebrado' },
  { value: 'CONFISSAO_DIVIDA',    label: 'Contrato de Confissão de Dívida' },
  { value: 'RETENCAO',            label: 'Retenção' },
  { value: 'DISTRATO',            label: 'Distrato' },
  { value: 'DEVOLUCAO',           label: 'Devolução' },
  { value: 'AJUSTE_INTERNO',      label: 'Ajuste interno' },
  { value: 'SEM_RETORNO',         label: 'Sem resposta/retorno do cliente' },
  { value: 'PROTESTO',            label: 'Protesto' },
  { value: 'JURIDICO',            label: 'Jurídico' },
  { value: 'ACORDO_JURIDICO',     label: 'Acordo Jurídico' },
  { value: 'TERCEIRIZADA',        label: 'Terceirizada' },
  { value: 'NEGATIVADO',          label: 'Negativado' },
  { value: 'PERDA',               label: 'Perda' }
];

const STATUS_VALIDOS = STATUS_LIST.map((s) => s.value);
const STATUS_SET = new Set(STATUS_VALIDOS);

const STATUS_CLIENTE_SET = new Set(STATUS_CLIENTE_LIST.map((s) => s.value));

// Rótulo de qualquer status gravado (cliente, título ou valor antigo do cliente).
const LABELS = Object.fromEntries([...STATUS_CLIENTE_LIST, ...STATUS_LIST].map((s) => [s.value, s.label]));

module.exports = {
  STATUS_LIST, STATUS_VALIDOS, STATUS_SET,
  STATUS_CLIENTE_LIST, STATUS_CLIENTE_SET, LABELS
};

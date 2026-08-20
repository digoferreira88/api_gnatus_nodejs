// services/cobrancaStatus.js — fonte ÚNICA dos status de cobrança (valor + rótulo).
// Espelha STATUS_VALIDOS de resources/cobranca/cobranca.status.js e os rótulos de
// frontend ClienteCobranca.tsx (STATUS_LABEL). Usado pelo filtro escondido do
// dashboard (config + validação).

const STATUS_LIST = [
  { value: 'REGULAR',             label: 'Regular' },
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

module.exports = { STATUS_LIST, STATUS_VALIDOS, STATUS_SET };

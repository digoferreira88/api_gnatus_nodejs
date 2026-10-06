// Lista OFICIAL de status da cobrança Omni (definida pelo setor em 05/10/2026).
// FONTE ÚNICA no backend. O frontend (CobrancaOmni.tsx) espelha value+label+cor;
// manter em sincronia ao alterar. Ver também services/cobrancaStatus.js (painel antigo, lista diferente).
const STATUS_LIST = [
  { value: 'PAGAMENTO_AGENDADO',       label: 'Pagamento Agendado' },
  { value: 'NEGATIVADO',               label: 'Negativado' },
  { value: 'CLIENTE_NAO_RESPONDE',     label: 'Cliente Não Responde' },
  { value: 'COBRANCA_FIADOR_DENTISTA', label: 'Cobrança – Fiador e Dentista' },
  { value: 'COBRANCA_FIADOR',          label: 'Cobrança – Fiador' },
  { value: 'COBRANCA_DENTISTA',        label: 'Cobrança – Dentista' },
  { value: 'TITULO_PAGO_GNATUS',       label: 'Título Pago pela Gnatus' },
  { value: 'CONTRATO_RECOMPRA',        label: 'Contrato para Recompra' },
  { value: 'CLIENTE_NAO_INFORMA_DATA', label: 'Cliente Não Informa Data de Pagamento' },
  { value: 'AGENDAMENTO_NAO_CUMPRIDO', label: 'Agendamento Não Cumprido' },
  { value: 'PAGO',                     label: 'Pago' },
  { value: 'INVERSAO_PAGAMENTO',       label: 'Inversão de Pagamento' },
  { value: 'PROTESTO',                 label: 'Protesto' },
  { value: 'TITULO_PAGO',              label: 'Título Pago' },
  { value: 'REFINANCIAMENTO_GNATUS',   label: 'Refinanciamento Gnatus' },
  { value: 'NOTIFICACAO_EXTRAJUDICIAL_EMAIL', label: 'Notificação Extrajudicial - E-mail' },
  { value: 'NOTIFICACAO_EXTRAJUDICIAL_AR',    label: 'Notificação Extrajudicial - AR' },
  { value: 'SEM_CONDICAO_PAGAMENTO',   label: 'Sem condição de pagamento' },
  { value: 'NAO_LOCALIZADO',           label: 'Não localizado' },
  { value: 'BLOQUEIO_SCANNER',         label: 'Bloqueio de Scanner' }
];
const STATUS_VALIDOS = STATUS_LIST.map((s) => s.value);
const STATUS_SET = new Set(STATUS_VALIDOS);

// Faixas de atraso que o portal Omni entrega (uma aba por faixa).
const FAIXAS = ['1 a 30', '31 a 60', '61 a 90'];

module.exports = { STATUS_LIST, STATUS_VALIDOS, STATUS_SET, FAIXAS };

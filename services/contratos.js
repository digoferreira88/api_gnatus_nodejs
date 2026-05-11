// services/contratos.js
// Helpers compartilhados entre os endpoints de Contratos:
//   - tipos validos
//   - calculo de status (em runtime)
//   - geracao de numero do contrato (CT/AAAA/SEQ)

const TIPOS_VALIDOS = ['LOCACAO', 'FORNECIMENTO', 'MANUTENCAO', 'COMODATO', 'CLIENTE', 'PJ'];

const TIPOS_LABEL = {
  LOCACAO:      'Locação Imobiliária',
  FORNECIMENTO: 'Fornecimento de Produtos/Serviços',
  MANUTENCAO:   'Manutenção',
  COMODATO:     'Comodato',
  CLIENTE:      'Contrato com Cliente',
  PJ:           'Prestador PJ / Trabalhista'
};

const CONTRAPARTE_TIPOS = ['CLIENTE', 'FORNECEDOR', 'PESSOA_FISICA', 'OUTRO'];

const INDICES = ['IPCA', 'IGPM', 'INPC', 'IGPC', 'SELIC', 'NENHUM'];

// Calcula o status efetivo em runtime — nunca grava na tabela
// (o status real depende sempre de "hoje").
function calcularStatus (contrato) {
  if (!contrato) return 'RASCUNHO';
  if (contrato.encerrado) return 'ENCERRADO';
  if (!contrato.vigencia_inicio) return 'RASCUNHO';

  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const ini = new Date(contrato.vigencia_inicio + 'T00:00:00');
  const fim = contrato.vigencia_fim ? new Date(contrato.vigencia_fim + 'T00:00:00') : null;

  if (hoje < ini) return 'AGUARDANDO';  // assinado mas ainda nao iniciou
  if (!fim) return 'VIGENTE';            // sem prazo de fim
  if (hoje > fim) return 'VENCIDO';

  const diasParaFim = Math.floor((fim.getTime() - hoje.getTime()) / 86400000);
  if (diasParaFim <= 90) return 'VENCENDO';
  return 'VIGENTE';
}

function diasParaVencimento (contrato) {
  if (!contrato || !contrato.vigencia_fim) return null;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const fim = new Date(contrato.vigencia_fim + 'T00:00:00');
  return Math.floor((fim.getTime() - hoje.getTime()) / 86400000);
}

// Gera proximo numero do contrato: CT/AAAA/SEQ (sequencial por ano).
// Usa COUNT por ano — simples, suficiente pra volume ate 9999/ano.
async function proximoNumero (Pg) {
  const ano = new Date().getFullYear();
  const r = await Pg.connectAndQuery(
    `SELECT COUNT(*) qt FROM tab_contrato WHERE numero LIKE @lk`,
    { lk: `CT/${ano}/%` }
  );
  const seq = Number(r[0]?.qt || 0) + 1;
  return `CT/${ano}/${String(seq).padStart(4, '0')}`;
}

// Enriquece o contrato com status calculado e dias_vencimento
function enriquecer (c) {
  if (!c) return c;
  return {
    ...c,
    status: calcularStatus(c),
    dias_para_vencimento: diasParaVencimento(c)
  };
}

module.exports = {
  TIPOS_VALIDOS, TIPOS_LABEL, CONTRAPARTE_TIPOS, INDICES,
  calcularStatus, diasParaVencimento, proximoNumero, enriquecer
};

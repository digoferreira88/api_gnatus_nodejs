// services/creditoRegistro.js — enums padronizados + validação do Registro de
// Análise de Crédito (repositório único da Liberação Financeira). Fonte única
// da verdade dos valores aceitos; o frontend espelha estas listas.

const RESULTADOS = [
  'Aprovado',
  'Aprovado – Alçada Gerente',
  'Aprovado – Alçada Comitê',
  'Aprovado com Ressalva',
  'Reprovado',
  'Solicitar Documentação',
  'Encaminhado para financeira'
];

const MOTIVOS = [
  'Restrições financeiras',
  'Score abaixo da política',
  'Renda não comprovada',
  'Endividamento elevado',
  'Renda incompatível com a operação',
  'Necessidade de fiador',
  'Documentação pendente',
  'Divergência cadastral'
];

const TIPOS_ANALISE = ['Nova análise', 'Reanálise', 'Alteração de Condição'];

const CANAIS = ['LIBERACAO', 'MANUAL'];
const CANAL_ORIGENS = ['E-mail', 'Teams', 'Comercial', 'Diretoria', 'Outros'];

const trim = (v) => String(v == null ? '' : v).trim();

// Valida o payload de um registro. Retorna { ok, erros[] } | { ok:true, dados }.
function validar(body) {
  const erros = [];
  const b = body || {};

  const tipo = trim(b.tipoAnalise);
  const canal = trim(b.canal) || 'LIBERACAO';
  const resultado = trim(b.resultado);
  const parecer = trim(b.parecer);
  const motivos = Array.isArray(b.motivos) ? b.motivos.map(trim).filter(Boolean) : [];

  if (!TIPOS_ANALISE.includes(tipo)) erros.push(`Tipo de análise inválido (aceitos: ${TIPOS_ANALISE.join(', ')}).`);
  if (!CANAIS.includes(canal)) erros.push('Canal inválido (LIBERACAO ou MANUAL).');
  if (!RESULTADOS.includes(resultado)) erros.push('Resultado inválido — selecione uma das opções padronizadas.');
  if (!parecer) erros.push('O parecer técnico é obrigatório.');

  const motivosInvalidos = motivos.filter((m) => !MOTIVOS.includes(m));
  if (motivosInvalidos.length) erros.push(`Motivo(s) fora do padrão: ${motivosInvalidos.join(', ')}.`);

  const canalOrigem = trim(b.canalOrigem);
  if (canal === 'MANUAL') {
    if (!canalOrigem || !CANAL_ORIGENS.includes(canalOrigem)) {
      erros.push(`Para solicitação manual, informe a origem (${CANAL_ORIGENS.join(', ')}).`);
    }
    if (!trim(b.clienteNome) && !trim(b.clienteCod)) {
      erros.push('Solicitação manual exige ao menos o nome ou o código do cliente.');
    }
  }

  if (erros.length) return { ok: false, erros };

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  return {
    ok: true,
    dados: {
      buCod: trim(b.buCod).slice(0, 10),
      buNome: trim(b.buNome).slice(0, 120),
      pedido: trim(b.pedido).slice(0, 20) || null,
      clienteCod: trim(b.clienteCod).slice(0, 20) || null,
      clienteLoja: trim(b.clienteLoja).slice(0, 10) || null,
      clienteNome: trim(b.clienteNome).slice(0, 200) || null,
      cnpj: trim(b.cnpj).slice(0, 20) || null,
      valorTotal: num(b.valorTotal),
      valorEntrada: num(b.valorEntrada),
      parcelasQtd: Math.max(0, Math.trunc(num(b.parcelasQtd))),
      parcelasValor: num(b.parcelasValor),
      tipoAnalise: tipo,
      canal,
      canalOrigem: canal === 'MANUAL' ? canalOrigem : null,
      resultado,
      motivos,
      parecer: parecer.slice(0, 8000)
    }
  };
}

// Reprova/aprova com base no resultado — útil para KPIs/relatórios.
const ehAprovacao = (resultado) => String(resultado || '').toLowerCase().startsWith('aprovado') || resultado === 'Encaminhado para financeira';

module.exports = { RESULTADOS, MOTIVOS, TIPOS_ANALISE, CANAIS, CANAL_ORIGENS, validar, ehAprovacao };

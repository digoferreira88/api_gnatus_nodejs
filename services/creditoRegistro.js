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

// Condições liberadas — forma de pagamento aceita para o cliente.
const FORMAS_PAGAMENTO = [
  'Boleto', 'Cartão de crédito', 'Financiamento (financeira)', 'À vista / PIX',
  'Cheque', 'Cartão BNDES', 'Outra'
];

// Análise do mesmo CPF/CNPJ dentro desta janela = possível duplicidade: o registro
// novo pede confirmação, e a tela mostra a análise anterior e as condições dela.
// É também a validade padrão das condições liberadas sem data definida.
const JANELA_DUPLICIDADE_DIAS = 90;

const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const tipoDocumento = (d) => (d.length === 11 ? 'CPF' : d.length === 14 ? 'CNPJ' : null);

// Reprova/aprova com base no resultado — útil para KPIs/relatórios.
const ehAprovacao = (resultado) => String(resultado || '').toLowerCase().startsWith('aprovado') || resultado === 'Encaminhado para financeira';
// Resultado que encerra a análise (aprovação ou reprovação). "Solicitar
// Documentação" fica pendente e não substitui uma decisão anterior.
const ehDecisivo = (resultado) => ehAprovacao(resultado) || resultado === 'Reprovado';

// Número opcional: '' / null → null; inválido → NaN (vira erro na validação).
const numOpc = (v) => {
  if (v == null || trim(v) === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

// Valida o payload de um registro. Retorna { ok:false, erros[] } | { ok:true, dados }.
// opts.novo = registro novo (não é nova versão): exige CPF/CNPJ na solicitação manual.
function validar(body, opts = {}) {
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

  // CPF/CNPJ: guardado só com dígitos (a tela formata).
  const documento = soDig(b.cnpj);
  if (documento && !tipoDocumento(documento)) erros.push('CPF/CNPJ inválido — informe 11 (CPF) ou 14 (CNPJ) dígitos.');

  const canalOrigem = trim(b.canalOrigem);
  if (canal === 'MANUAL') {
    if (!canalOrigem || !CANAL_ORIGENS.includes(canalOrigem)) {
      erros.push(`Para solicitação manual, informe a origem (${CANAL_ORIGENS.join(', ')}).`);
    }
    if (!trim(b.clienteNome) && !trim(b.clienteCod)) {
      erros.push('Solicitação manual exige ao menos o nome ou o código do cliente.');
    }
    // Sem o documento não há como saber se a pessoa/empresa já foi analisada.
    if (opts.novo && !documento) erros.push('Informe o CPF/CNPJ — ele é usado para evitar análise em duplicidade.');
  }

  // Data/hora em que a solicitação chegou (opcional) — não pode ser no futuro.
  let solicitadoEm = null;
  if (trim(b.solicitadoEm)) {
    const d = new Date(trim(b.solicitadoEm));
    if (isNaN(d.getTime())) erros.push('Data de recebimento da solicitação inválida.');
    else if (d.getTime() > Date.now() + 5 * 60e3) erros.push('A data de recebimento da solicitação não pode ser no futuro.');
    else solicitadoEm = d.toISOString();
  }

  // Condições liberadas — só valem para aprovação.
  const c = b.condicoes || {};
  let condicoes = null;
  if (ehAprovacao(resultado)) {
    const forma = trim(c.formaPagamento);
    const valorMax = numOpc(c.valorMax);
    const entradaMinPct = numOpc(c.entradaMinPct);
    const parcelasMax = numOpc(c.parcelasMax);
    const validade = trim(c.validade);
    const obs = trim(c.observacao);
    if (forma && !FORMAS_PAGAMENTO.includes(forma)) erros.push(`Forma de pagamento inválida (aceitas: ${FORMAS_PAGAMENTO.join(', ')}).`);
    if (Number.isNaN(valorMax) || (valorMax != null && valorMax < 0)) erros.push('Valor máximo liberado inválido.');
    if (Number.isNaN(entradaMinPct) || (entradaMinPct != null && (entradaMinPct < 0 || entradaMinPct > 100))) erros.push('Entrada mínima deve ser um percentual entre 0 e 100.');
    if (Number.isNaN(parcelasMax) || (parcelasMax != null && (parcelasMax < 0 || !Number.isInteger(parcelasMax)))) erros.push('Número máximo de parcelas inválido.');
    if (validade && !/^\d{4}-\d{2}-\d{2}$/.test(validade)) erros.push('Validade das condições inválida.');
    if (obs.length > 500) erros.push('Observação das condições: máximo de 500 caracteres.');
    condicoes = {
      formaPagamento: forma || null,
      valorMax: valorMax == null || Number.isNaN(valorMax) ? null : Math.round(valorMax * 100) / 100,
      entradaMinPct: entradaMinPct == null || Number.isNaN(entradaMinPct) ? null : Math.round(entradaMinPct * 100) / 100,
      parcelasMax: parcelasMax == null || Number.isNaN(parcelasMax) ? null : parcelasMax,
      validade: validade || null,
      observacao: obs || null
    };
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
      cnpj: documento || null,
      valorTotal: num(b.valorTotal),
      valorEntrada: num(b.valorEntrada),
      parcelasQtd: Math.max(0, Math.trunc(num(b.parcelasQtd))),
      parcelasValor: num(b.parcelasValor),
      tipoAnalise: tipo,
      canal,
      canalOrigem: canal === 'MANUAL' ? canalOrigem : null,
      resultado,
      motivos,
      parecer: parecer.slice(0, 8000),
      solicitadoEm,
      condicoes: condicoes || { formaPagamento: null, valorMax: null, entradaMinPct: null, parcelasMax: null, validade: null, observacao: null }
    }
  };
}

// Colunas lidas em toda consulta de registro (alias `r`). A validade sai como
// texto 'YYYY-MM-DD' para não sofrer conversão de fuso no driver.
const COLS = `r.id, r.grupo_id, r.versao, r.vigente, r.substituido_por,
  r.bu_cod, r.bu_nome, r.pedido, r.cliente_cod, r.cliente_loja, r.cliente_nome, r.cnpj, r.documento,
  r.valor_total, r.valor_entrada, r.parcelas_qtd, r.parcelas_valor,
  r.tipo_analise, r.canal, r.canal_origem, r.resultado, r.motivos, r.parecer,
  r.analista_id, r.analista_nome, r.criado_em,
  r.cond_forma_pagamento, r.cond_valor_max, r.cond_entrada_min_pct, r.cond_parcelas_max,
  to_char(r.cond_validade, 'YYYY-MM-DD') AS cond_validade, r.cond_observacao,
  r.solicitado_em, r.anterior_grupo_id, r.duplicidade_confirmada`;

const N = (v) => Number(v || 0);
const nOuNull = (v) => (v == null ? null : Number(v));

// Linha do banco -> objeto da API (mesmo formato em lista, histórico e cruzamento).
function mapRegistro(r) {
  const condicoes = {
    formaPagamento: trim(r.cond_forma_pagamento) || null,
    valorMax: nOuNull(r.cond_valor_max),
    entradaMinPct: nOuNull(r.cond_entrada_min_pct),
    parcelasMax: nOuNull(r.cond_parcelas_max),
    validade: trim(r.cond_validade) || null,
    observacao: trim(r.cond_observacao) || null
  };
  const temCondicoes = Object.values(condicoes).some((v) => v != null);
  return {
    id: r.id, grupoId: r.grupo_id, versao: r.versao, editado: Number(r.versao) > 1,
    vigente: r.vigente, substituidoPor: r.substituido_por,
    buCod: trim(r.bu_cod), buNome: trim(r.bu_nome),
    pedido: trim(r.pedido), clienteCod: trim(r.cliente_cod), clienteLoja: trim(r.cliente_loja),
    clienteNome: trim(r.cliente_nome), cnpj: trim(r.cnpj), documento: trim(r.documento),
    valorTotal: N(r.valor_total), valorEntrada: N(r.valor_entrada),
    parcelasQtd: N(r.parcelas_qtd), parcelasValor: N(r.parcelas_valor),
    tipoAnalise: trim(r.tipo_analise), canal: trim(r.canal), canalOrigem: trim(r.canal_origem),
    resultado: trim(r.resultado), motivos: Array.isArray(r.motivos) ? r.motivos : [],
    parecer: trim(r.parecer), analistaNome: trim(r.analista_nome), criadoEm: r.criado_em,
    condicoes: temCondicoes ? condicoes : null,
    solicitadoEm: r.solicitado_em || null,
    anteriorGrupoId: r.anterior_grupo_id || null,
    duplicidadeConfirmada: !!r.duplicidade_confirmada
  };
}

// Data 'YYYY-MM-DD' de hoje no fuso de Brasília (a VPS roda em UTC).
const hojeBrasilia = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

// Condições liberadas que ainda valem para o documento. Olha a análise DECISIVA
// mais recente (aprovação ou reprovação): se for aprovação dentro da validade
// (ou, sem validade definida, dentro da janela), as condições dela valem.
// `registros` = vigentes do documento, do mais recente ao mais antigo.
function condicoesVigentes(registros) {
  const ultima = (registros || []).find((r) => ehDecisivo(r.resultado));
  if (!ultima || !ehAprovacao(ultima.resultado)) return null;
  const hoje = hojeBrasilia();
  let validaAte = ultima.condicoes && ultima.condicoes.validade;
  if (!validaAte) {
    const d = new Date(new Date(ultima.criadoEm).getTime() + JANELA_DUPLICIDADE_DIAS * 864e5 - 3 * 3600e3);
    validaAte = d.toISOString().slice(0, 10);
  }
  if (validaAte < hoje) return null;
  return {
    grupoId: ultima.grupoId, resultado: ultima.resultado, criadoEm: ultima.criadoEm,
    analistaNome: ultima.analistaNome, validaAte, validadeDefinida: !!(ultima.condicoes && ultima.condicoes.validade),
    condicoes: ultima.condicoes,
    operacao: { valorTotal: ultima.valorTotal, valorEntrada: ultima.valorEntrada, parcelasQtd: ultima.parcelasQtd, parcelasValor: ultima.parcelasValor }
  };
}

module.exports = {
  RESULTADOS, MOTIVOS, TIPOS_ANALISE, CANAIS, CANAL_ORIGENS, FORMAS_PAGAMENTO, JANELA_DUPLICIDADE_DIAS,
  validar, ehAprovacao, ehDecisivo, soDig, tipoDocumento, COLS, mapRegistro, condicoesVigentes, hojeBrasilia
};

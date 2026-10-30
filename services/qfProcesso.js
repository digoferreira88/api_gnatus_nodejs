// services/qfProcesso.js — andamento da qualificação (PRO 7.3.7 itens 5.1–5.8) e da
// requalificação anual (item 5.10).
//
// O andamento NÃO é um campo que alguém marca: é derivado do que existe (documentos,
// fichas, auditoria, amostra, avaliações, análises). A barra de progresso e o bloqueio
// da aprovação usam a MESMA conta — o endpoint de aprovação chama `progresso()`.

const Core = require('./qfCore');
const R = require('./qfRegras');

const ETAPAS_INICIAL = [
  { id: 'CADASTRO',     titulo: 'Dados cadastrais' },
  { id: 'CRITICIDADE',  titulo: 'Criticidade (itens que fornece)' },
  { id: 'DOCUMENTOS',   titulo: 'Documentação (PRO 5.3)' },
  { id: 'QUESTIONARIO', titulo: 'FORM 7.3.21 — cadastro e questionário' },
  { id: 'ANALISE',      titulo: 'Avaliação crítica do questionário (Qualidade)' },
  { id: 'AUDITORIA',    titulo: 'Auditoria no fornecedor (PRO 5.6)' },
  { id: 'AMOSTRA',      titulo: 'Amostra (PRO 5.7)' },
  { id: 'AVALIACAO',    titulo: 'Avaliação dimensional (7.3.22) e funcional (7.3.23)' },
  { id: 'APROVACAO',    titulo: 'Aprovação do FORM 7.3.21 (Gerente de Engenharia)' }
];
const ETAPAS_REQUALIFICACAO = [
  { id: 'FORM_7328',     titulo: 'FORM 7.3.28 — enviado ao fornecedor e devolvido' },
  { id: 'DOCUMENTAL',    titulo: 'Análise documental (inclui Acordo de Qualidade)' },
  { id: 'DESEMPENHO',    titulo: 'Análise de desempenho dos últimos 12 meses' },
  { id: 'ALTERACOES',    titulo: 'Análise das alterações declaradas' },
  { id: 'QUESTIONARIO',  titulo: 'Novo FORM 7.3.21 (se decidido)' },
  { id: 'AUDITORIA',     titulo: 'Auditoria (se decidida — PRO 5.6.2)' },
  { id: 'AMOSTRA',       titulo: 'Nova amostra (se decidida)' },
  { id: 'AVALIACAO',     titulo: 'Avaliação dimensional e funcional (se decidida)' },
  { id: 'APROVACAO',     titulo: 'Aprovação do FORM 7.3.28 (Gerente de Engenharia)' }
];
const ETAPAS = ETAPAS_INICIAL;   // compatibilidade

async function carregar(Pg, fornecedorId, processoId = null) {
  const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id: fornecedorId });
  if (!f) return null;
  const processos = await Pg.connectAndQuery(
    `SELECT q.*, ui.nome AS iniciado_por_nome FROM tab_qf_qualificacao q
       LEFT JOIN tab_intranet_usr ui ON ui.id = q.iniciado_por
      WHERE q.fornecedor_id = @id ORDER BY q.id DESC`, { id: fornecedorId });
  const proc = processoId
    ? processos.find(p => p.id === Number(processoId)) || null
    : processos.find(p => ['EM_ANDAMENTO', 'PAUSADO'].includes(p.status)) || processos[0] || null;
  const fichas = await Pg.connectAndQuery(
    `SELECT f.*, ua.nome AS analisada_por_nome FROM tab_qf_ficha f LEFT JOIN tab_intranet_usr ua ON ua.id = f.analisada_por
      WHERE f.fornecedor_id = @id ORDER BY f.id DESC`, { id: fornecedorId });
  const auditorias = await Pg.connectAndQuery(`SELECT * FROM tab_qf_auditoria WHERE fornecedor_id = @id ORDER BY id DESC`, { id: fornecedorId });
  const amostras = await Pg.connectAndQuery(`SELECT * FROM tab_qf_amostra WHERE fornecedor_id = @id ORDER BY id DESC`, { id: fornecedorId });
  const avaliacoes = await Pg.connectAndQuery(
    `SELECT a.*, (SELECT COUNT(*)::int FROM tab_qf_avaliacao_item i WHERE i.avaliacao_id = a.id) itens,
            (SELECT COUNT(*)::int FROM tab_qf_avaliacao_item i WHERE i.avaliacao_id = a.id AND i.status = 'NAO_CONFORME') itens_nc
       FROM tab_qf_avaliacao a WHERE a.fornecedor_id = @id ORDER BY a.id DESC`, { id: fornecedorId });
  const checklist = await Core.checklistFornecedor(Pg, f);
  const regra = await Core.regraAtiva(Pg);
  const desempenho = proc && proc.tipo === 'REQUALIFICACAO' ? await Core.desempenho12m(Pg, regra.conteudo, fornecedorId) : null;
  return { fornecedor: f, processos, processo: proc, fichas, auditorias, amostras, avaliacoes, checklist, desempenho };
}

const doProcesso = (lista, proc) => (proc ? lista.filter(x => x.qualificacao_id === proc.id) : lista);
const avOk = (a) => a && ['APROVADO', 'APROVADO_COM_RESTRICAO', 'NAO_APLICAVEL'].includes(a.resultado);
const fmtD = (d) => (d ? new Date(d).toLocaleDateString('pt-BR') : '');

// etapas comuns (questionário, auditoria, amostra, avaliação); `exigida` = se a etapa vale neste fluxo
function etapasComuns(ctx, { exigeQuestionario, exigeAuditoria, exigeAmostra }) {
  const { processo: proc } = ctx;
  const fichas = doProcesso(ctx.fichas, proc).filter(x => x.formulario === '7.3.21');
  const ficha = fichas[0] || null;
  const auds = doProcesso(ctx.auditorias, proc).filter(a => a.status !== 'CANCELADA');
  const amostras = doProcesso(ctx.amostras, proc).filter(a => a.status !== 'CANCELADA');
  const avs = doProcesso(ctx.avaliacoes, proc);
  const ultimaAv = (tipo) => avs.find(a => a.tipo === tipo && a.resultado) || null;
  const dim = ultimaAv('DIMENSIONAL'), fun = ultimaAv('FUNCIONAL');
  const audOk = auds.find(a => a.status === 'REALIZADA' && ['CONFORME', 'CONFORME_COM_OBSERVACOES'].includes(a.resultado));
  const audNc = auds.find(a => a.status === 'REALIZADA' && a.resultado === 'NAO_CONFORME');
  const st = {};
  st.QUESTIONARIO = !exigeQuestionario ? { status: 'na' }
    : !ficha ? { status: 'pendente', detalhe: 'FORM 7.3.21 ainda não enviado ao fornecedor' }
    : ['RESPONDIDA', 'ANALISADA'].includes(ficha.status) ? { status: 'ok', detalhe: `respondido ${fmtD(ficha.respondida_em)}` }
    : ficha.status === 'DEVOLVIDA' ? { status: 'aguardando', detalhe: 'devolvido ao fornecedor para refazer' }
    : { status: 'aguardando', detalhe: 'aguardando o fornecedor preencher' };
  st.ANALISE = !exigeQuestionario ? { status: 'na' }
    : ficha && ficha.status === 'ANALISADA'
      ? { status: ficha.resultado === 'REPROVADO' ? 'falhou' : 'ok', detalhe: `${String(ficha.resultado).replace(/_/g, ' ').toLowerCase()} · ${Number(ficha.pontuacao_percentual).toFixed(1).replace('.', ',')}%` }
      : { status: 'pendente', detalhe: 'aguardando a Qualidade' };
  st.AUDITORIA = exigeAuditoria === false ? { status: 'na', detalhe: proc && proc.auditoria_justificativa ? `não necessária — ${proc.auditoria_justificativa}` : 'não necessária' }
    : audNc && !audOk ? { status: 'falhou', detalhe: 'auditoria não conforme' }
    : audOk ? { status: 'ok', detalhe: `realizada ${fmtD(audOk.data_realizada)}` }
    : exigeAuditoria === true ? { status: auds.length ? 'aguardando' : 'pendente', detalhe: auds.length ? 'agendada' : 'decidida como necessária — agendar' }
    : { status: 'pendente', detalhe: 'a Engenharia decide se é necessária (com justificativa)' };
  st.AMOSTRA = !exigeAmostra ? { status: 'na', detalhe: proc && proc.amostra_dispensada ? (proc.amostra_justificativa || 'dispensada') : undefined }
    : amostras.some(a => ['RECEBIDA', 'AVALIADA'].includes(a.status)) ? { status: 'ok' }
    : amostras.length ? { status: 'aguardando', detalhe: 'solicitada, aguardando recebimento' }
    : { status: 'pendente' };
  st.AVALIACAO = !exigeAmostra ? { status: 'na' }
    : (dim && dim.resultado === 'REPROVADO') || (fun && fun.resultado === 'REPROVADO') ? { status: 'falhou', detalhe: 'avaliação reprovada' }
    : avOk(dim) && avOk(fun) ? { status: 'ok', detalhe: [dim.resultado === 'NAO_APLICAVEL' && 'dimensional não aplicável'].filter(Boolean).join('') || undefined }
    : { status: 'pendente', detalhe: [!avOk(dim) && 'dimensional', !avOk(fun) && 'funcional'].filter(Boolean).join(' e ') + ' pendente(s)' };
  const restricao = (ficha && ficha.resultado === 'APROVADO_COM_RESTRICAO') || [dim, fun].some(a => a && a.resultado === 'APROVADO_COM_RESTRICAO');
  return { st, ficha, restricao };
}

function progresso(ctx) {
  const proc = ctx.processo;
  if (proc && proc.tipo === 'REQUALIFICACAO') return progressoRequalificacao(ctx);
  const { fornecedor: f, checklist } = ctx;
  const crit = R.monitorado(f);
  const exigeAuditoria = !crit ? false : (proc ? proc.auditoria_necessaria : null);
  const comum = etapasComuns(ctx, { exigeQuestionario: crit, exigeAuditoria, exigeAmostra: crit && !(proc && proc.amostra_dispensada) });
  const st = { ...comum.st };
  st.CADASTRO = { status: f.razao_social ? 'ok' : 'pendente' };
  st.CRITICIDADE = proc && proc.criticidade_definida
    ? { status: 'ok', detalhe: crit ? `Crítico ${R.normCriticidades(f.criticidades).join(', ')}` : 'não crítico — não exige qualificação prévia (PRO 5.1)' }
    : { status: 'pendente', detalhe: 'defina as criticidades pelos itens que o fornecedor fornece' };
  st.DOCUMENTOS = !crit ? { status: 'na', detalhe: 'não crítico — sem documentos' }
    : { status: checklist.completo ? 'ok' : 'pendente', detalhe: checklist.completo ? `obrigatórios em dia${checklist.protocolados ? ` (${checklist.protocolados} por protocolo)` : ''}` : `${checklist.pendentes} obrigatório(s) pendente(s)` };
  st.APROVACAO = aprovacaoStatus(proc);
  const etapas = ETAPAS_INICIAL.map(e => ({ ...e, ...st[e.id] }));
  const bloqueios = bloqueiosDe(etapas, proc);
  if (crit && comum.ficha && comum.ficha.resultado === 'APROVADO_COM_RESTRICAO' && !String(comum.ficha.plano_acao || '').trim()) bloqueios.push('Questionário aprovado com restrição sem plano de ação registrado (PRO 5.5).');
  const falhas = etapas.filter(e => e.status === 'falhou' && e.id !== 'APROVACAO').map(e => e.titulo);
  const aberto = proc && ['EM_ANDAMENTO', 'PAUSADO'].includes(proc.status);
  return {
    tipo: proc ? proc.tipo : 'INICIAL',
    etapas, percentual: percentual(etapas), etapaAtual: etapaAtual(etapas), bloqueios, falhas,
    auditoriaSugerida: crit ? R.auditoriaInicialSugerida(f.criticidades, checklist) : [],
    resultadosPermitidos: !aberto ? [] : (falhas.length || bloqueios.length) ? ['REPROVADO']
      : comum.restricao ? ['APROVADO_COM_RESTRICAO', 'REPROVADO'] : ['APROVADO', 'APROVADO_COM_RESTRICAO', 'REPROVADO'],
    ficha: comum.ficha ? { id: comum.ficha.id, status: comum.ficha.status, resultado: comum.ficha.resultado, percentual: comum.ficha.pontuacao_percentual } : null
  };
}

function progressoRequalificacao(ctx) {
  const { fornecedor: f, processo: proc, checklist, desempenho } = ctx;
  const an = (proc && proc.analise) || {};
  const alt = an.alteracoes || {};
  const f7328 = doProcesso(ctx.fichas, proc).find(x => x.formulario === '7.3.28') || null;
  const comum = etapasComuns(ctx, { exigeQuestionario: !!alt.questionario, exigeAuditoria: alt.auditoria ? true : false, exigeAmostra: !!alt.novaAmostra });
  const st = { ...comum.st };
  st.FORM_7328 = !f7328 ? { status: 'pendente', detalhe: 'enviar o FORM 7.3.28 ao fornecedor' }
    : ['RESPONDIDA', 'ANALISADA'].includes(f7328.status) ? { status: 'ok', detalhe: `devolvido ${fmtD(f7328.respondida_em)}` }
    : { status: 'aguardando', detalhe: `aguardando o fornecedor (link vale até ${fmtD(f7328.token_expira_em)})` };
  st.DOCUMENTAL = an.documental && an.documental.parecer
    ? { status: 'ok', detalhe: checklist.completo ? 'documentação em dia' : `${checklist.pendentes} obrigatório(s) pendente(s) — registrado no parecer` }
    : { status: 'pendente', detalhe: checklist.completo ? 'documentação em dia — registrar o parecer' : `${checklist.pendentes} obrigatório(s) pendente(s)` };
  st.DESEMPENHO = an.desempenho && an.desempenho.parecer
    ? { status: 'ok', detalhe: desempenho && desempenho.semFornecimento ? 'sem fornecimento no período (PRO 5.10.1 Nota 2)' : `IQF 12 meses ${desempenho && desempenho.iqf != null ? desempenho.iqf.toFixed(2).replace('.', ',') : '—'} (classe ${desempenho && desempenho.classe || '—'})` }
    : { status: 'pendente', detalhe: 'registrar a análise de desempenho (IQF, NCs, reclamações, planos de ação)' };
  st.ALTERACOES = alt.decidido
    ? { status: alt.aceitas === false ? 'falhou' : 'ok', detalhe: alt.aceitas === false ? 'alterações não aceitas' : [alt.questionario && 'novo questionário', alt.auditoria && 'auditoria', alt.novaAmostra && 'nova amostra'].filter(Boolean).join(', ') || 'sem nova avaliação' }
    : { status: f7328 && ['RESPONDIDA', 'ANALISADA'].includes(f7328.status) ? 'pendente' : 'aguardando', detalhe: 'analisar as alterações declaradas no FORM 7.3.28' };
  st.APROVACAO = aprovacaoStatus(proc);
  const etapas = ETAPAS_REQUALIFICACAO.map(e => ({ ...e, ...st[e.id] }));
  const bloqueios = bloqueiosDe(etapas, proc);
  const falhas = etapas.filter(e => e.status === 'falhou' && e.id !== 'APROVACAO').map(e => e.titulo);
  const sugestao = R.avaliarRequalificacao({
    checklist, classe12m: desempenho ? desempenho.classe : null,
    alteracoesAceitas: alt.decidido ? alt.aceitas !== false : null,
    formularioDevolvido: f7328 ? ['RESPONDIDA', 'ANALISADA'].includes(f7328.status) : null
  });
  const aberto = proc && ['EM_ANDAMENTO', 'PAUSADO'].includes(proc.status);
  const ordem = ['REQUALIFICADO', 'REQUALIFICADO_COM_RESTRICAO', 'NAO_REQUALIFICADO'];
  return {
    tipo: 'REQUALIFICACAO',
    etapas, percentual: percentual(etapas), etapaAtual: etapaAtual(etapas), bloqueios, falhas, sugestao, desempenho,
    vencimento: f.qualificacao_valida_ate,
    // NÃO REQUALIFICADO pode ser registrado a qualquer momento (ex.: FORM 7.3.28 não devolvido no prazo)
    resultadosPermitidos: !aberto ? [] : (bloqueios.length || falhas.length) ? ['NAO_REQUALIFICADO']
      : ordem.slice(ordem.indexOf(sugestao.resultado)),
    ficha: f7328 ? { id: f7328.id, status: f7328.status, formulario: '7.3.28' } : null
  };
}

function aprovacaoStatus(proc) {
  if (!proc) return { status: 'pendente' };
  if (proc.status === 'APROVADO') return { status: 'ok', detalhe: `${String(proc.aprovacao_resultado || '').replace(/_/g, ' ').toLowerCase()} · ${proc.aprovacao_nome || ''} · ${fmtD(proc.aprovacao_em)}` };
  if (proc.status === 'REPROVADO') return { status: 'falhou', detalhe: String(proc.aprovacao_resultado || 'reprovado').replace(/_/g, ' ').toLowerCase() };
  return { status: 'pendente' };
}
function bloqueiosDe(etapas, proc) {
  const b = [];
  if (!proc) b.push('Nenhum processo aberto.');
  else if (!['EM_ANDAMENTO', 'PAUSADO'].includes(proc.status)) b.push(`Processo já encerrado (${proc.status}).`);
  for (const e of etapas) if (e.id !== 'APROVACAO' && ['pendente', 'aguardando'].includes(e.status)) b.push(`${e.titulo}: ${e.detalhe || 'pendente'}.`);
  return b;
}
const percentual = (etapas) => Math.round((etapas.filter(e => ['ok', 'na'].includes(e.status)).length / etapas.length) * 100);
const etapaAtual = (etapas) => (etapas.find(e => !['ok', 'na', 'opcional'].includes(e.status)) || etapas[etapas.length - 1]).id;

module.exports = { ETAPAS, ETAPAS_INICIAL, ETAPAS_REQUALIFICACAO, carregar, progresso };

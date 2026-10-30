// services/qfRegras.js — regras PURAS da Qualificação de Fornecedores (PRO 7.3.7 REV OUT261).
//
// Nada aqui toca banco: tudo recebe a versão de regra (JSON de tab_qf_regra_versao)
// e os dados, e devolve o cálculo. É o que test/qfRegras.test.js exercita, e é a ÚNICA
// implementação das fórmulas — a tela pede o cálculo ao backend.
//
//   IQF = C × P × N   (PRO 5.9)
//   C = conformidade do lote (aprovada ÷ inspecionada)
//   P = prazo: nacional pela data prevista de ENTREGA, importado pela de COLETA,
//       antecipação com tabela própria (vale para os dois)
//   N = NCs nas últimas entregas (janela da regra; OUT261: 3 entregas do fornecedor + item)

const r4 = (x) => Math.round(Number(x) * 10000) / 10000;
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const CRITICIDADES = ['A', 'B', 'C', 'D'];

// Código do fornecedor do Protheus: 6 dígitos com zeros à esquerda ("1365" → "001365").
function normalizarCodigo(c) {
  const s = String(c == null ? '' : c).trim();
  if (/^\d{1,6}$/.test(s)) return s.padStart(6, '0');
  return s.toUpperCase();
}

// Item comparado sem zeros à esquerda (planilha "12614" = Protheus "012614").
const chaveItem = (c) => String(c == null ? '' : c).trim().toUpperCase().replace(/^0+(?=.)/, '');

// Conjunto de criticidades (A/B/C/D) a partir de array, "A,B", "A e B" etc. Vazio = não crítico.
function normCriticidades(v) {
  const lista = Array.isArray(v) ? v : String(v == null ? '' : v).toUpperCase().split(/[^A-D]+/);
  return CRITICIDADES.filter(c => lista.map(x => String(x).trim().toUpperCase()).includes(c));
}
const monitorado = (f) => normCriticidades(f && f.criticidades).length > 0;

function temRnc(rnc) {
  const s = String(rnc == null ? '' : rnc).trim().toUpperCase();
  return !!s && !['N/A', 'NA', 'N.A.', '-', '—', '0', 'NAO', 'NÃO', 'SEM RNC'].includes(s);
}
function ehNC({ qtdReprovada, rncNumero }) {
  return (num(qtdReprovada) || 0) > 0 || temRnc(rncNumero);
}

// ----------------------------------------------------------------- C
function calcularC(regra, { qtdInspecionada, qtdAprovada }) {
  const qi = num(qtdInspecionada), qa = num(qtdAprovada);
  if (qi == null || qi <= 0 || qa == null) return null;
  const pct = qa >= qi ? 100 : (qa / qi) * 100;
  const faixas = [...(regra.faixasC || [])].sort((a, b) => b.min - a.min);
  const faixa = faixas.find(f => pct >= f.min - 1e-9) || faixas[faixas.length - 1];
  return { valor: num(faixa.valor), pct: r4(pct), rotulo: faixa.rotulo || null };
}

// ----------------------------------------------------------------- P
function paraDiaUTC(d) {
  if (!d) return null;
  if (d instanceof Date) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
// dias = real − prevista (negativo = antecipação)
function diasEntre(prevista, real) {
  const a = paraDiaUTC(prevista), b = paraDiaUTC(real);
  if (a == null || b == null) return null;
  return Math.round((b - a) / 86400000);
}
const ordenarAte = (lista) => [...(lista || [])].sort((a, b) =>
  (a.ate == null ? Infinity : a.ate) - (b.ate == null ? Infinity : b.ate));
const faixaAte = (lista, x) => { const o = ordenarAte(lista); return o.find(f => f.ate == null || x <= f.ate) || o[o.length - 1]; };

// Regra nova (OUT261): { prazo: { nacional, importado, antecipacao } }.
// Regra antiga (planilha): faixasP com dias negativos/positivos numa tabela só.
function calcularP(regra, dias, { importado = false } = {}) {
  if (dias == null || !Number.isFinite(Number(dias))) return null;
  const d = Number(dias);
  if (regra.prazo) {
    if (d < 0) {
      const f = faixaAte(regra.prazo.antecipacao, -d);
      return { valor: num(f.valor), dias: d, tabela: 'ANTECIPACAO', rotulo: f.rotulo || null };
    }
    const tabela = importado ? 'IMPORTADO' : 'NACIONAL';
    const f = faixaAte(importado ? regra.prazo.importado : regra.prazo.nacional, d);
    return { valor: num(f.valor), dias: d, tabela, rotulo: f.rotulo || null };
  }
  const f = faixaAte(regra.faixasP, d);
  return { valor: num(f.valor), dias: d, tabela: 'LEGADO', rotulo: f.rotulo || null };
}

// ----------------------------------------------------------------- N
function calcularN(regra, ncs) {
  const n = Math.max(0, Number(ncs) || 0);
  const faixas = [...(regra.faixasN || [])].sort((a, b) => a.ncs - b.ncs);
  let faixa = faixas[0];
  for (const f of faixas) if (n >= f.ncs) faixa = f;
  return { valor: num(faixa.valor), ncs: n, rotulo: faixa.rotulo || null };
}

function calcularIQF(c, p, n) {
  if (c == null || p == null || n == null) return null;
  return r4(Number(c) * Number(p) * Number(n));
}

// ----------------------------------------------------------------- classe A–E
function classificar(regra, iqf) {
  const v = num(iqf);
  if (v == null) return null;
  const classes = [...(regra.classes || [])].sort((a, b) =>
    (b.min == null ? -Infinity : b.min) - (a.min == null ? -Infinity : a.min));
  const c = classes.find(k => k.min == null || v >= k.min - 1e-9);
  return c ? { classe: c.classe, rotulo: c.rotulo, cor: c.cor, acao: c.acao } : null;
}

function iqfMedio(lista) {
  const vals = (lista || []).map(num).filter(v => v != null);
  if (!vals.length) return { media: null, qtd: 0 };
  return { media: r4(vals.reduce((a, b) => a + b, 0) / vals.length), qtd: vals.length };
}

// Valores aceitos para ajuste manual de um índice.
function valoresPermitidos(regra, indice) {
  let lista;
  if (indice === 'C') lista = regra.faixasC;
  else if (indice === 'N') lista = regra.faixasN;
  else lista = regra.prazo ? [...(regra.prazo.nacional || []), ...(regra.prazo.importado || []), ...(regra.prazo.antecipacao || [])] : regra.faixasP;
  return [...new Set((lista || []).map(f => num(f.valor)))].sort((a, b) => b - a);
}

// ----------------------------------------------------------------- inspeção completa
// dados: qtdInspecionada, qtdAprovada, qtdReprovada, rncNumero, dataEntregaPrevista,
//        dataEntregaReal, importado, ajustes { c, p, n }
function calcularInspecao(regra, dados, ncsAnteriores) {
  const aj = dados.ajustes || {};
  const c = calcularC(regra, dados);
  const dias = diasEntre(dados.dataEntregaPrevista, dados.dataEntregaReal);
  const p = calcularP(regra, dias, { importado: !!dados.importado });
  const n = calcularN(regra, ncsAnteriores);

  const indiceC = aj.c != null ? num(aj.c) : (c ? c.valor : null);
  const indiceP = aj.p != null ? num(aj.p) : (p ? p.valor : null);
  const indiceN = aj.n != null ? num(aj.n) : (n ? n.valor : null);
  const iqf = calcularIQF(indiceC, indiceP, indiceN);

  return {
    pctConforme: c ? c.pct : null,
    diasAtraso: dias,
    tabelaP: p ? p.tabela : (dados.importado ? 'IMPORTADO' : 'NACIONAL'),
    tipoPrazo: dados.importado ? 'COLETA' : 'ENTREGA',
    nc: ehNC(dados),
    ncsJanela: n.ncs,
    indiceC, indiceP, indiceN, iqf,
    manual: { c: aj.c != null, p: aj.p != null, n: aj.n != null },
    calculado: { c: c ? c.valor : null, p: p ? p.valor : null, n: n.valor },
    rotulos: { c: c && c.rotulo, p: p && p.rotulo, n: n.rotulo },
    classeInspecao: classificar(regra, iqf)
  };
}

// Validação da inspeção. `inspecao100`: fornecedor em classe D só recebe com 100% do lote.
function validarInspecao(d, { hoje = new Date().toISOString().slice(0, 10), inspecao100 = false } = {}) {
  const e = [];
  const qi = num(d.qtdInspecionada), qa = num(d.qtdAprovada), qrep = num(d.qtdReprovada), qr = num(d.qtdRecebida);
  if (!d.fornecedorId) e.push('Selecione o fornecedor.');
  if (qr == null || qr <= 0) e.push('Informe a quantidade recebida.');
  if (qi == null || qi <= 0) e.push('Informe a quantidade inspecionada.');
  if (qa == null || qa < 0) e.push('Informe a quantidade aprovada.');
  if (qrep == null || qrep < 0) e.push('Informe a quantidade reprovada (0 se nenhuma).');
  if (qi != null && qa != null && qrep != null && Math.abs(qa + qrep - qi) > 1e-6) {
    e.push(`Aprovada (${qa}) + reprovada (${qrep}) precisa ser igual à inspecionada (${qi}).`);
  }
  if (qi != null && qr != null && qi - qr > 1e-6) e.push('A quantidade inspecionada não pode passar da recebida.');
  if (d.nivelInspecao && !['I', 'II', 'III', '100'].includes(String(d.nivelInspecao))) e.push('Nível de inspeção inválido.');
  // classe D: o lote inteiro (nível "100" ou qualquer nível com inspecionada = recebida)
  if (inspecao100 && qi != null && qr != null && Math.abs(qi - qr) > 1e-6) {
    e.push('Fornecedor em classe D: recebimento só com inspeção de 100% do lote (inspecionada = recebida, sem amostragem).');
  }
  if (!d.dataInspecao) e.push('Informe a data da inspeção.');
  const di = paraDiaUTC(d.dataInspecao), dr = paraDiaUTC(d.dataEntregaReal), dh = paraDiaUTC(hoje);
  if (di != null && dh != null && di > dh) e.push('A data da inspeção não pode estar no futuro.');
  if (di != null && dr != null && di < dr) e.push(d.importado ? 'A data da inspeção não pode ser anterior à coleta real.' : 'A data da inspeção não pode ser anterior à entrega real.');
  const aj = d.ajustes || {};
  if (aj.p == null && (!d.dataEntregaPrevista || !d.dataEntregaReal)) {
    e.push(d.importado
      ? 'Informe a coleta prevista e a real (importado: o P é pela data de coleta) ou ajuste o P com justificativa.'
      : 'Informe a entrega prevista e a real (ou ajuste o índice P com justificativa).');
  }
  if ((aj.c != null || aj.p != null || aj.n != null) && !String(d.ajusteJustificativa || '').trim()) {
    e.push('Ajuste manual de índice exige justificativa.');
  }
  return e;
}

// ----------------------------------------------------------------- amostragem (NBR 5426)
function amostragem(regra, nivel, qtdRecebida) {
  const q = num(qtdRecebida);
  if (q == null || q <= 0) return null;
  if (String(nivel) === '100') return { amostra: q, ac: 0, re: 1, faixa: '100% do lote', norma: '100%' };
  const tabela = regra.amostragem && regra.amostragem[String(nivel)];
  if (!Array.isArray(tabela) || !tabela.length) return null;
  if (q < tabela[0].de) return { amostra: q, ac: 0, re: 1, faixa: `lote menor que ${tabela[0].de}: 100%`, norma: regra.amostragem.norma };
  const linha = tabela.find(l => q >= l.de && q <= l.ate) || tabela[tabela.length - 1];
  return { amostra: Math.min(linha.amostra, q), ac: linha.ac, re: linha.re, faixa: `${linha.de} a ${linha.ate}`, norma: regra.amostragem.norma };
}

// ----------------------------------------------------------------- questionário (FORM 7.3.21)
// Pergunta deixada em branco vale NÃO (observação do FORM 7.3.21). O denominador é o
// total de perguntas aplicáveis (com `perguntas`) ou o de respostas.
function pontuarQuestionario(regra, respostas, perguntas = null) {
  const pontos = regra.pontos || { SIM: 2, PARCIAL: 1, NAO: 0 };
  const max = Math.max(...Object.values(pontos).map(Number));
  const lista = respostas || [];
  const porId = new Map(lista.map(r => [Number(r.perguntaId ?? r.pergunta_id), r]));
  const base = perguntas
    ? perguntas.map(p => ({ secao: p.secao, alternativa: (porId.get(Number(p.id)) || {}).alternativa || 'NAO' }))
    : lista.map(r => ({ secao: r.pergunta_secao || r.secao, alternativa: r.alternativa }));
  const total = base.reduce((a, r) => a + (Number(pontos[r.alternativa]) || 0), 0);
  const maximo = base.length * max;
  const percentual = maximo > 0 ? r2((total / maximo) * 100) : 0;
  const secoes = new Map();
  for (const r of base) {
    const k = r.secao || '—';
    const s = secoes.get(k) || { secao: k, total: 0, maximo: 0 };
    s.total += Number(pontos[r.alternativa]) || 0; s.maximo += max;
    secoes.set(k, s);
  }
  const porSecao = [...secoes.values()].map(s => ({ ...s, percentual: s.maximo ? r2(s.total / s.maximo * 100) : 0 }));
  const q = regra.questionario || { aprovado_min: 70, restricao_min: 50 };
  const resultado = percentual >= q.aprovado_min ? 'APROVADO' : percentual >= q.restricao_min ? 'APROVADO_COM_RESTRICAO' : 'REPROVADO';
  return { total, maximo, percentual, resultado, porSecao };
}

// Uma alternativa por pergunta (PRO 5.5: mais de uma → refazer); comprovação obrigatória
// quando o fornecedor declara que atende (SIM/PARCIAL); em branco é aceito e vale NÃO.
function validarRespostas(perguntas, respostas) {
  const e = [];
  const ids = new Set(perguntas.map(p => Number(p.id)));
  const porPergunta = new Map();
  for (const r of respostas || []) {
    const id = Number(r.perguntaId);
    if (!ids.has(id)) { e.push(`Resposta para pergunta inexistente (${id}).`); continue; }
    if (!porPergunta.has(id)) porPergunta.set(id, []);
    porPergunta.get(id).push(r);
  }
  for (const p of perguntas) {
    const rs = (porPergunta.get(Number(p.id)) || []).filter(r => r.alternativa);
    if (rs.length > 1) { e.push(`Pergunta ${p.codigo} com mais de uma alternativa marcada — o questionário precisa ser refeito (PRO 7.3.7 item 5.5).`); continue; }
    if (!rs.length) continue;
    if (!['SIM', 'PARCIAL', 'NAO'].includes(rs[0].alternativa)) e.push(`Pergunta ${p.codigo}: alternativa inválida.`);
    else if (rs[0].alternativa !== 'NAO' && !String(rs[0].comprovacao || '').trim()) e.push(`Pergunta ${p.codigo}: informe a comprovação da alternativa escolhida.`);
  }
  return e;
}
const emBranco = (perguntas, respostas) => {
  const resp = new Set((respostas || []).filter(r => r.alternativa).map(r => Number(r.perguntaId)));
  return perguntas.filter(p => !resp.has(Number(p.id))).map(p => p.codigo);
};

function perguntasAplicaveis(perguntas, criticidades) {
  const crit = normCriticidades(criticidades);
  return (perguntas || []).filter(p => p.ativo !== false && (
    p.aplicavel_a === 'TODOS' || crit.includes(String(p.aplicavel_a || '').replace('CRITICO_', ''))));
}

// ----------------------------------------------------------------- documentos (PRO 5.3)
const FORTE = { OBRIGATORIO: 2, CONDICIONAL: 1 };
function regraDocumento(tipo, criticidades) {
  let melhor = null;
  for (const c of normCriticidades(criticidades)) {
    const r = tipo[`regra_${c.toLowerCase()}`];
    if (r && (!melhor || FORTE[r] > FORTE[melhor])) melhor = r;
  }
  return melhor;
}

function documentosExigidos(tipos, { criticidades, nacional }) {
  return (tipos || [])
    .filter(t => t.ativo !== false)
    .map(t => ({ tipo: t, regra: regraDocumento(t, criticidades) }))
    .filter(x => x.regra && !(x.tipo.somente_nacional && nacional === false));
}

// Situação de cada documento exigido. Protocolo com prazo de regularização vencido
// conta como vencido (PRO 5.4 / 5.11).
function checklistDocumentos(tipos, docs, fornecedor, ficha, { hoje = new Date().toISOString().slice(0, 10), avisoDias = 30 } = {}) {
  const dh = paraDiaUTC(hoje);
  const itens = documentosExigidos(tipos, fornecedor).map(({ tipo, regra }) => {
    const ativos = (docs || [])
      .filter(d => Number(d.tipo_documento_id) === Number(tipo.id) && !['SUBSTITUIDO', 'EXCLUIDO'].includes(d.status))
      .sort((x, y) => String(y.enviado_em).localeCompare(String(x.enviado_em)));
    const doc = ativos[0] || null;
    let situacao = 'PENDENTE', venceEm = null;
    if (tipo.gerado_sistema && ficha && ficha.status === 'ANALISADA' && ['APROVADO', 'APROVADO_COM_RESTRICAO'].includes(ficha.resultado)) {
      situacao = 'OK';
    } else if (doc) {
      if (doc.status === 'DISPENSADO') situacao = 'DISPENSADO';
      else if (doc.status === 'PROTOCOLADO') {
        const dp = paraDiaUTC(doc.prazo_regularizacao);
        situacao = dp != null && dp < dh ? 'PROTOCOLO_VENCIDO' : 'PROTOCOLADO';
        if (dp != null && dp >= dh) venceEm = Math.round((dp - dh) / 86400000);
      } else {
        const dv = paraDiaUTC(doc.data_validade);
        if (dv != null && dv < dh) situacao = 'VENCIDO';
        else {
          situacao = 'OK';
          if (dv != null) { venceEm = Math.round((dv - dh) / 86400000); if (venceEm <= avisoDias) situacao = 'VENCENDO'; }
        }
      }
    }
    return { tipoId: tipo.id, codigo: tipo.codigo, nome: tipo.nome, regra, condicao: tipo.condicao, exigeValidade: tipo.exige_validade, geradoSistema: tipo.gerado_sistema, situacao, venceEm, documento: doc };
  });
  const ok = (s) => ['OK', 'VENCENDO', 'PROTOCOLADO', 'DISPENSADO'].includes(s);
  const obrig = itens.filter(i => i.regra === 'OBRIGATORIO');
  return {
    itens,
    completo: obrig.every(i => ok(i.situacao)),
    pendentes: obrig.filter(i => !ok(i.situacao)).length,
    vencidos: itens.filter(i => ['VENCIDO', 'PROTOCOLO_VENCIDO'].includes(i.situacao)).length,
    protocolados: itens.filter(i => i.situacao === 'PROTOCOLADO').length,
    vencendo: itens.filter(i => i.situacao === 'VENCENDO').length
  };
}

// ----------------------------------------------------------------- auditoria (PRO 5.6)
// 5.6.1 — sugestão para a qualificação inicial (a decisão é da Engenharia, com justificativa).
function auditoriaInicialSugerida(criticidades, checklist) {
  const crit = normCriticidades(criticidades);
  const motivos = [];
  if (crit.includes('B')) motivos.push('Fornecedor Crítico B (dispositivos médicos) — PRO 5.6.1.');
  if (crit.includes('A')) {
    const iso = (checklist && checklist.itens || []).find(i => i.codigo === 'CERT_ISO');
    if (!iso || !['OK', 'VENCENDO'].includes(iso.situacao)) motivos.push('Crítico A sem certificação ISO 13485 / ISO 9001 válida — PRO 5.6.1.');
  }
  return motivos;
}

// 5.6.2 — gatilhos de auditoria de acompanhamento a partir do histórico:
//   mediasApos: média do IQF do fornecedor depois de cada inspeção (ordem cronológica)
//   datas:      data de cada uma dessas inspeções (mesma ordem; opcional)
//   ncsDatas:   datas das entregas com NC dentro da janela (opcional; ou só ncsRecentes)
//   ultimaAuditoria: data da última auditoria REALIZADA — se é posterior ao momento em que
//     o gatilho se formou, a sugestão já foi atendida; volta só se o gatilho se formar de novo.
function auditoriaAcompanhamento(regra, { mediasApos = [], datas = [], ncsDatas = null, ncsRecentes = 0, ultimaAuditoria = null }) {
  const cfg = regra.auditoriaAcompanhamento || { iqfLimite: 7, avaliacoesConsecutivas: 2, ncsMinimo: 3, ncsJanelaMeses: 6 };
  const motivos = [];
  const aud = paraDiaUTC(ultimaAuditoria);
  const atendido = (quando) => aud != null && quando != null && aud >= quando;
  // sequência atual de médias abaixo do limite
  let seq = 0;
  for (let i = mediasApos.length - 1; i >= 0 && mediasApos[i] != null && mediasApos[i] < cfg.iqfLimite; i--) seq++;
  if (seq >= cfg.avaliacoesConsecutivas) {
    const formou = paraDiaUTC(datas[mediasApos.length - seq + cfg.avaliacoesConsecutivas - 1]);
    if (!atendido(formou)) motivos.push(`IQF abaixo de ${String(cfg.iqfLimite).replace(".", ",")} por ${seq} avaliações consecutivas (classe C ou D).`);
  }
  const lista = Array.isArray(ncsDatas) ? [...ncsDatas].map(paraDiaUTC).filter(x => x != null).sort((a, b) => a - b) : null;
  const qtd = lista ? lista.length : ncsRecentes;
  if (qtd >= cfg.ncsMinimo) {
    const formou = lista ? lista[lista.length - cfg.ncsMinimo] : null;
    if (!atendido(formou)) motivos.push(`${qtd} entregas com não conformidade nos últimos ${cfg.ncsJanelaMeses} meses.`);
  }
  return motivos;
}

// ----------------------------------------------------------------- requalificação (PRO 5.10.2)
// Sugere o resultado a partir dos critérios; o gerente registra a decisão final.
function avaliarRequalificacao({ checklist, classe12m, alteracoesAceitas, formularioDevolvido }) {
  const motivos = { nao: [], restricao: [] };
  const acordo = (checklist.itens || []).find(i => i.codigo === 'ACORDO_QUALIDADE');
  if (checklist.itens.some(i => i.regra === 'OBRIGATORIO' && ['VENCIDO', 'PROTOCOLO_VENCIDO', 'PENDENTE'].includes(i.situacao))) motivos.nao.push('documentação obrigatória vencida/pendente sem protocolo');
  if (acordo && !['OK', 'VENCENDO'].includes(acordo.situacao)) motivos.nao.push('Acordo de Qualidade não vigente');
  if (classe12m === 'E') motivos.nao.push('IQF classe E (IQF < 5)');
  if (alteracoesAceitas === false) motivos.nao.push('alterações declaradas não aceitas pela Engenharia');
  if (formularioDevolvido === false) motivos.nao.push('FORM 7.3.28 não devolvido');
  if (checklist.itens.some(i => i.situacao === 'PROTOCOLADO')) motivos.restricao.push('documento(s) apresentado(s) por protocolo');
  if (['C', 'D'].includes(classe12m)) motivos.restricao.push(`IQF classe ${classe12m} (5 ≤ IQF < 8)`);
  const resultado = motivos.nao.length ? 'NAO_REQUALIFICADO' : motivos.restricao.length ? 'REQUALIFICADO_COM_RESTRICAO' : 'REQUALIFICADO';
  return { resultado, motivos };
}

// ----------------------------------------------------------------- validação de uma versão de regra
function validarRegra(c) {
  const e = [];
  if (!c || typeof c !== 'object') return ['Conteúdo da regra ausente.'];
  const faixas = (nome, lista, campo) => {
    if (!Array.isArray(lista) || !lista.length) { e.push(`"${nome}" precisa ter ao menos uma faixa.`); return; }
    lista.forEach((f, i) => { if ((f[campo] !== null && num(f[campo]) == null) || num(f.valor) == null) e.push(`${nome}[${i}]: ${campo} e valor numéricos.`); });
    if (campo === 'ate' && !lista.some(f => f.ate == null)) e.push(`"${nome}" precisa de uma faixa final sem limite ("ate": null).`);
  };
  faixas('faixasC', c.faixasC, 'min');
  if (c.prazo) {
    faixas('prazo.nacional', c.prazo.nacional, 'ate');
    faixas('prazo.importado', c.prazo.importado, 'ate');
    faixas('prazo.antecipacao', c.prazo.antecipacao, 'ate');
  } else faixas('faixasP', c.faixasP, 'ate');
  faixas('faixasN', c.faixasN, 'ncs');
  if (Array.isArray(c.faixasN) && !c.faixasN.some(f => Number(f.ncs) === 0)) e.push('faixasN precisa da faixa de 0 NC.');
  const cl = Array.isArray(c.classes) ? c.classes : (e.push('"classes" precisa ter ao menos uma classe.'), []);
  if (cl.length && !cl.some(k => k.min == null)) e.push('classes precisa de uma classe final sem mínimo ("min": null).');
  cl.forEach((k, i) => { if (!/^[A-Z]$/.test(String(k.classe || ''))) e.push(`classes[${i}]: classe deve ser uma letra.`); });
  if (!(Number(c.janelaN) >= 1)) e.push('janelaN deve ser ≥ 1.');
  if (!['FORNECEDOR', 'FORNECEDOR_ITEM'].includes(c.escopoN)) e.push('escopoN deve ser FORNECEDOR ou FORNECEDOR_ITEM.');
  const q = c.questionario || {};
  if (!(num(q.aprovado_min) > num(q.restricao_min))) e.push('questionario.aprovado_min deve ser maior que restricao_min.');
  return e;
}

module.exports = {
  CRITICIDADES, normalizarCodigo, chaveItem, normCriticidades, monitorado, temRnc, ehNC,
  calcularC, calcularP, calcularN, calcularIQF, diasEntre, classificar, iqfMedio, valoresPermitidos,
  calcularInspecao, validarInspecao,
  amostragem,
  pontuarQuestionario, validarRespostas, emBranco, perguntasAplicaveis,
  regraDocumento, documentosExigidos, checklistDocumentos,
  auditoriaInicialSugerida, auditoriaAcompanhamento, avaliarRequalificacao,
  validarRegra
};

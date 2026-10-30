// Testes das fórmulas da Qualificação de Fornecedores (services/qfRegras.js).
// Rodar:  npm test
//
// As tabelas vêm do PRÓPRIO seed da migration 133 (lido do .sql): PRO 7.3.7 REV OUT261
// (ativa) e a planilha FORM 7.4.3.H (histórico). O teste nunca diverge do banco.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../services/qfRegras');

const sql = fs.readFileSync(path.join(__dirname, '../database/postgres/133-qualificacao-fornecedores.sql'), 'utf8');
const PRO = JSON.parse(sql.split('$j$')[1]);
const PLANILHA = JSON.parse(sql.split('$h$')[1]);

test('seed das duas versões de regra é válido', () => {
  assert.deepEqual(R.validarRegra(PRO), []);
  assert.deepEqual(R.validarRegra(PLANILHA), []);
});

test('validarRegra recusa conteúdo incompleto', () => {
  const ruim = { ...PRO, prazo: { nacional: [{ ate: 3, valor: 1 }], importado: [], antecipacao: [{ ate: null, valor: 1 }] }, classes: [{ classe: 'A', min: 9 }], janelaN: 0 };
  const e = R.validarRegra(ruim);
  assert.ok(e.some(m => m.includes('prazo.nacional')));
  assert.ok(e.some(m => m.includes('prazo.importado')));
  assert.ok(e.some(m => m.includes('classes')));
  assert.ok(e.some(m => m.includes('janelaN')));
});

test('códigos e criticidades', () => {
  assert.equal(R.normalizarCodigo(1365), '001365');
  assert.equal(R.normalizarCodigo('003794'), '003794');
  assert.equal(R.chaveItem('012614'), '12614');
  assert.equal(R.chaveItem('12614'), '12614');
  assert.deepEqual(R.normCriticidades('A e B'), ['A', 'B']);
  assert.deepEqual(R.normCriticidades(['d', 'A']), ['A', 'D']);
  assert.deepEqual(R.normCriticidades('Não'), []);
  assert.equal(R.monitorado({ criticidades: [] }), false);
  assert.equal(R.monitorado({ criticidades: ['C'] }), true);
});

test('índice C pelas faixas de conformidade', () => {
  const c = (qi, qa) => R.calcularC(PRO, { qtdInspecionada: qi, qtdAprovada: qa })?.valor;
  assert.equal(c(5, 5), 10);
  assert.equal(c(100, 80), 8);
  assert.equal(c(1000, 799), 5);
  assert.equal(c(100, 60), 3);
  assert.equal(c(1000, 599), 0);
  assert.equal(c(0, 0), undefined);
});

test('índice P — NACIONAL (PRO 7.3.7 OUT261, data prevista de entrega)', () => {
  const p = (d) => R.calcularP(PRO, d).valor;
  assert.equal(p(0), 1);
  assert.equal(p(2), 1);
  assert.equal(p(3), 0.95);
  assert.equal(p(4), 0.9);
  assert.equal(p(5), 0.9);
  assert.equal(p(7), 0.85);
  assert.equal(p(10), 0.8);
  assert.equal(p(15), 0.7);
  assert.equal(p(16), 0.6);
  assert.equal(R.calcularP(PRO, 3).tabela, 'NACIONAL');
});

test('índice P — IMPORTADO (data prevista de coleta)', () => {
  const p = (d) => R.calcularP(PRO, d, { importado: true }).valor;
  assert.equal(p(0), 1);
  assert.equal(p(5), 1);
  assert.equal(p(6), 0.9);
  assert.equal(p(7), 0.9);
  assert.equal(p(10), 0.8);
  assert.equal(p(15), 0.6);
  assert.equal(p(40), 0.6);
  assert.equal(R.calcularP(PRO, 6, { importado: true }).tabela, 'IMPORTADO');
});

test('índice P — ANTECIPAÇÃO (nacionais e importados)', () => {
  const p = (d, imp = false) => R.calcularP(PRO, d, { importado: imp }).valor;
  assert.equal(p(-1), 1);
  assert.equal(p(-2), 1);
  assert.equal(p(-3), 0.9);
  assert.equal(p(-5), 0.9);
  assert.equal(p(-6), 0.8);
  assert.equal(p(-10), 0.8);
  assert.equal(p(-15), 0.7);
  assert.equal(p(-16), 0.5);
  assert.equal(p(-16, true), 0.5);
  assert.equal(R.calcularP(PRO, -4).tabela, 'ANTECIPACAO');
});

test('índice P — tabela da planilha (histórico)', () => {
  const p = (d) => R.calcularP(PLANILHA, d).valor;
  assert.equal(p(-1), 1.1);
  assert.equal(p(1), 1.0);
  assert.equal(p(3), 0.9);
  assert.equal(p(5), 0.8);
  assert.equal(p(6), 0.7);
});

test('índice N e NC', () => {
  const n = (k) => R.calcularN(PRO, k).valor;
  assert.equal(n(0), 1.0);
  assert.equal(n(1), 0.9);
  assert.equal(n(2), 0.8);
  assert.equal(n(5), 0.7);
  assert.equal(PRO.escopoN, 'FORNECEDOR_ITEM');
  assert.equal(R.ehNC({ qtdReprovada: 0, rncNumero: 'N/A' }), false);
  assert.equal(R.ehNC({ qtdReprovada: 3 }), true);
  assert.equal(R.ehNC({ qtdReprovada: 0, rncNumero: '0011-23' }), true);
});

test('IQF e classes — teto passa a ser 10 (antecipação não bonifica mais)', () => {
  assert.equal(R.calcularIQF(10, 1, 1), 10);
  assert.equal(R.calcularIQF(8, 0.95, 0.9), 6.84);
  const k = (v) => R.classificar(PRO, v)?.classe;
  assert.equal(k(10), 'A');
  assert.equal(k(9), 'A');
  assert.equal(k(8.99), 'B');
  assert.equal(k(7), 'C');
  assert.equal(k(5), 'D');
  assert.equal(k(4.99), 'E');
  assert.equal(R.classificar(PRO, 7.5).acao, 'BLOQUEAR_PLANO');
  assert.equal(R.classificar(PRO, 6).acao, 'BLOQUEAR_PLANO_100');
  assert.equal(R.classificar(PRO, 3).acao, 'REPROVAR');
});

test('IQF médio — caso INFITEK (003794): 14 inspeções → 10,2857 (A)', () => {
  const m = R.iqfMedio([...Array(4).fill(11), ...Array(10).fill(10)]);
  assert.equal(m.qtd, 14);
  assert.equal(m.media, 10.2857);
  assert.equal(R.classificar(PRO, m.media).classe, 'A');
});

test('cálculo completo da inspeção: nacional atrasada, importado e antecipada', () => {
  const base = { qtdInspecionada: 50, qtdAprovada: 47, qtdReprovada: 3, dataEntregaPrevista: '2026-10-10', dataEntregaReal: '2026-10-13' };
  const nac = R.calcularInspecao(PRO, base, 1);
  assert.equal(nac.indiceC, 8);
  assert.equal(nac.indiceP, 0.95);
  assert.equal(nac.indiceN, 0.9);
  assert.equal(nac.iqf, 6.84);
  assert.equal(nac.tipoPrazo, 'ENTREGA');
  const imp = R.calcularInspecao(PRO, { ...base, importado: true }, 0);
  assert.equal(imp.indiceP, 1);
  assert.equal(imp.tipoPrazo, 'COLETA');
  const ant = R.calcularInspecao(PRO, { ...base, qtdAprovada: 50, qtdReprovada: 0, dataEntregaReal: '2026-10-04' }, 0);
  assert.equal(ant.indiceP, 0.8);   // 6 dias antes
  assert.equal(ant.iqf, 8);
  const aj = R.calcularInspecao(PRO, { ...base, ajustes: { n: 0.7 } }, 1);
  assert.equal(aj.indiceN, 0.7);
  assert.equal(aj.manual.n, true);
});

test('validação da inspeção (inclui classe D = 100% do lote)', () => {
  const ok = { fornecedorId: 1, qtdRecebida: 50, qtdInspecionada: 5, qtdAprovada: 5, qtdReprovada: 0, nivelInspecao: 'I', dataInspecao: '2026-10-20', dataEntregaPrevista: '2026-10-30', dataEntregaReal: '2026-10-19' };
  assert.deepEqual(R.validarInspecao(ok, { hoje: '2026-10-22' }), []);
  assert.ok(R.validarInspecao({ ...ok, qtdAprovada: 4 }, { hoje: '2026-10-22' }).some(m => m.includes('precisa ser igual')));
  assert.ok(R.validarInspecao({ ...ok, dataInspecao: '2026-12-29' }, { hoje: '2026-10-22' }).some(m => m.includes('futuro')));
  assert.ok(R.validarInspecao(ok, { hoje: '2026-10-22', inspecao100: true }).some(m => m.includes('100%')));
  const cem = { ...ok, nivelInspecao: '100', qtdInspecionada: 50, qtdAprovada: 50 };
  assert.deepEqual(R.validarInspecao(cem, { hoje: '2026-10-22', inspecao100: true }), []);
  // o lote inteiro também vale com outro rótulo de nível
  assert.deepEqual(R.validarInspecao({ ...cem, nivelInspecao: 'II' }, { hoje: '2026-10-22', inspecao100: true }), []);
  assert.ok(R.validarInspecao({ ...ok, importado: true, dataEntregaPrevista: null }, { hoje: '2026-10-22' }).some(m => m.includes('coleta')));
});

test('amostragem NBR 5426 (qtd. inspecionada depende do nível)', () => {
  assert.equal(R.amostragem(PRO, 'I', 50).amostra, 5);
  assert.equal(R.amostragem(PRO, 'II', 50).amostra, 8);
  assert.equal(R.amostragem(PRO, '100', 37).amostra, 37);
  assert.equal(R.amostragem(PRO, 'I', 1).amostra, 1);
});

test('questionário: 36 perguntas oficiais, branco vale NÃO e nota por seção', () => {
  const perguntas = [...sql.matchAll(/\('(\d\.\d)','([^']+)','/g)].map((m, i) => ({ id: i + 1, codigo: m[1], secao: m[2] }));
  assert.equal(perguntas.length, 36);
  assert.equal(new Set(perguntas.map(p => p.secao)).size, 6);
  // 30 SIM, 6 em branco → 60/72 = 83,33%
  const resp = perguntas.slice(0, 30).map(p => ({ perguntaId: p.id, alternativa: 'SIM', comprovacao: 'x' }));
  const r = R.pontuarQuestionario(PRO, resp, perguntas);
  assert.equal(r.maximo, 72);
  assert.equal(r.total, 60);
  assert.equal(r.percentual, 83.33);
  assert.equal(r.resultado, 'APROVADO');
  assert.equal(r.porSecao.length, 6);
  assert.equal(r.porSecao.find(s => s.secao.startsWith('6.')).percentual, 0);
  assert.deepEqual(R.emBranco(perguntas, resp).length, 6);
});

test('questionário: faixas 70% / 50%', () => {
  const p = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, codigo: `Q${i + 1}`, secao: 'S' }));
  const resp = (s, pa) => [...Array(s).fill('SIM'), ...Array(pa).fill('PARCIAL')].map((a, i) => ({ perguntaId: i + 1, alternativa: a, comprovacao: 'x' }));
  assert.equal(R.pontuarQuestionario(PRO, resp(7, 0), p(10)).resultado, 'APROVADO');                 // 70%
  assert.equal(R.pontuarQuestionario(PRO, resp(5, 0), p(10)).resultado, 'APROVADO_COM_RESTRICAO');   // 50%
  assert.equal(R.pontuarQuestionario(PRO, resp(4, 1), p(10)).resultado, 'REPROVADO');                // 45%
});

test('questionário: duas alternativas invalida; comprovação só para SIM/PARCIAL', () => {
  const perg = [{ id: 1, codigo: '1.1' }, { id: 2, codigo: '1.2' }];
  assert.deepEqual(R.validarRespostas(perg, [{ perguntaId: 1, alternativa: 'NAO' }]), []);
  const e = R.validarRespostas(perg, [
    { perguntaId: 1, alternativa: 'SIM', comprovacao: 'x' }, { perguntaId: 1, alternativa: 'NAO' },
    { perguntaId: 2, alternativa: 'PARCIAL', comprovacao: '' }]);
  assert.ok(e.some(m => m.includes('mais de uma alternativa')));
  assert.ok(e.some(m => m.includes('comprovação')));
});

test('documentos pela matriz A/B/C/D do FORM 7.3.21 OUT26', () => {
  const tipos = [
    { id: 1, codigo: 'JUNTA', regra_a: 'OBRIGATORIO', regra_b: 'OBRIGATORIO', regra_c: 'OBRIGATORIO', regra_d: 'OBRIGATORIO', somente_nacional: true },
    { id: 2, codigo: 'AFE', regra_a: 'CONDICIONAL', regra_b: 'OBRIGATORIO', regra_c: 'OBRIGATORIO', regra_d: null, somente_nacional: true },
    { id: 3, codigo: 'ISO17025', regra_a: null, regra_b: null, regra_c: null, regra_d: 'CONDICIONAL', somente_nacional: false },
    { id: 4, codigo: 'ACORDO_QUALIDADE', regra_a: 'OBRIGATORIO', regra_b: 'OBRIGATORIO', regra_c: 'OBRIGATORIO', regra_d: 'OBRIGATORIO', somente_nacional: false },
    { id: 5, codigo: 'CERT_ISO', regra_a: 'OBRIGATORIO', regra_b: 'CONDICIONAL', regra_c: 'CONDICIONAL', regra_d: null, somente_nacional: false }
  ];
  const cods = (crit, nac) => R.documentosExigidos(tipos, { criticidades: crit, nacional: nac }).map(x => `${x.tipo.codigo}:${x.regra[0]}`);
  assert.deepEqual(cods([], true), []);
  assert.deepEqual(cods(['A'], true), ['JUNTA:O', 'AFE:C', 'ACORDO_QUALIDADE:O', 'CERT_ISO:O']);
  assert.deepEqual(cods(['D'], true), ['JUNTA:O', 'ISO17025:C', 'ACORDO_QUALIDADE:O']);
  assert.deepEqual(cods(['A', 'B'], true), ['JUNTA:O', 'AFE:O', 'ACORDO_QUALIDADE:O', 'CERT_ISO:O']);
  assert.deepEqual(cods(['B'], false), ['ACORDO_QUALIDADE:O', 'CERT_ISO:C']);

  const forn = { criticidades: ['A'], nacional: true };
  const docs = [
    { id: 10, tipo_documento_id: 1, status: 'PROTOCOLADO', prazo_regularizacao: '2026-10-01', enviado_em: '2026-09-01' },
    { id: 11, tipo_documento_id: 4, status: 'VIGENTE', data_validade: null, enviado_em: '2026-09-01' },
    { id: 12, tipo_documento_id: 5, status: 'PROTOCOLADO', prazo_regularizacao: '2026-11-30', enviado_em: '2026-09-01' }
  ];
  const ck = R.checklistDocumentos(tipos, docs, forn, null, { hoje: '2026-10-22' });
  const sit = Object.fromEntries(ck.itens.map(i => [i.codigo, i.situacao]));
  assert.equal(sit.JUNTA, 'PROTOCOLO_VENCIDO');
  assert.equal(sit.CERT_ISO, 'PROTOCOLADO');
  assert.equal(sit.ACORDO_QUALIDADE, 'OK');
  assert.equal(ck.completo, false);
  assert.equal(ck.vencidos, 1);
});

test('auditoria: sugestões do PRO 5.6.1 e 5.6.2', () => {
  assert.equal(R.auditoriaInicialSugerida(['B'], { itens: [] }).length, 1);
  assert.equal(R.auditoriaInicialSugerida(['A'], { itens: [{ codigo: 'CERT_ISO', situacao: 'PENDENTE' }] }).length, 1);
  assert.equal(R.auditoriaInicialSugerida(['A'], { itens: [{ codigo: 'CERT_ISO', situacao: 'OK' }] }).length, 0);
  assert.equal(R.auditoriaAcompanhamento(PRO, { mediasApos: [9, 6.9, 6.5] }).length, 1);
  assert.equal(R.auditoriaAcompanhamento(PRO, { mediasApos: [6.5, 7.2] }).length, 0);
  assert.equal(R.auditoriaAcompanhamento(PRO, { mediasApos: [], ncsRecentes: 3 }).length, 1);
  // auditoria realizada depois de o gatilho se formar atende a sugestão…
  const datas = ['2026-01-10', '2026-02-10', '2026-03-10'];
  assert.equal(R.auditoriaAcompanhamento(PRO, { mediasApos: [9, 6.9, 6.5], datas, ultimaAuditoria: '2026-03-15' }).length, 0);
  // …mas não se foi antes (gatilho formado em 10/03)
  assert.equal(R.auditoriaAcompanhamento(PRO, { mediasApos: [9, 6.9, 6.5], datas, ultimaAuditoria: '2026-03-01' }).length, 1);
  // NCs: com auditoria após a 3ª NC mais recente, só volta com 3 NCs novas depois dela
  const nc = ['2026-01-05', '2026-02-05', '2026-03-05'];
  assert.equal(R.auditoriaAcompanhamento(PRO, { ncsDatas: nc, ultimaAuditoria: '2026-03-20' }).length, 0);
  assert.equal(R.auditoriaAcompanhamento(PRO, { ncsDatas: [...nc, '2026-04-01'], ultimaAuditoria: '2026-03-20' }).length, 0);
  assert.equal(R.auditoriaAcompanhamento(PRO, { ncsDatas: [...nc, '2026-04-01', '2026-04-02', '2026-04-03'], ultimaAuditoria: '2026-03-20' }).length, 1);
});

test('requalificação: critérios do PRO 5.10.2', () => {
  const ok = { itens: [{ codigo: 'ACORDO_QUALIDADE', regra: 'OBRIGATORIO', situacao: 'OK' }, { codigo: 'JUNTA', regra: 'OBRIGATORIO', situacao: 'OK' }] };
  assert.equal(R.avaliarRequalificacao({ checklist: ok, classe12m: 'A', alteracoesAceitas: true, formularioDevolvido: true }).resultado, 'REQUALIFICADO');
  assert.equal(R.avaliarRequalificacao({ checklist: ok, classe12m: 'D', alteracoesAceitas: true, formularioDevolvido: true }).resultado, 'REQUALIFICADO_COM_RESTRICAO');
  const prot = { itens: [...ok.itens, { codigo: 'ISO', regra: 'OBRIGATORIO', situacao: 'PROTOCOLADO' }] };
  assert.equal(R.avaliarRequalificacao({ checklist: prot, classe12m: null, alteracoesAceitas: null, formularioDevolvido: true }).resultado, 'REQUALIFICADO_COM_RESTRICAO');
  assert.equal(R.avaliarRequalificacao({ checklist: ok, classe12m: 'E', formularioDevolvido: true }).resultado, 'NAO_REQUALIFICADO');
  const venc = { itens: [{ codigo: 'JUNTA', regra: 'OBRIGATORIO', situacao: 'VENCIDO' }] };
  assert.equal(R.avaliarRequalificacao({ checklist: venc, classe12m: 'A', formularioDevolvido: true }).resultado, 'NAO_REQUALIFICADO');
  assert.equal(R.avaliarRequalificacao({ checklist: ok, classe12m: 'A', alteracoesAceitas: false, formularioDevolvido: true }).resultado, 'NAO_REQUALIFICADO');
});

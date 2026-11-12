// Testes do fluxo do pedido do CIOSP: vendedor envia, ADM confere e finaliza
// (services/ciospFluxo.js). Rodar:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../services/ciospFluxo');

const AGORA = new Date('2027-01-28T12:00:00Z');
const ctx = (o = {}) => ({ usuarioId: 7, agora: AGORA, forma: { exige_credito: true }, nomeResponsavel: 'Bruna', ...o });
const ped = (o = {}) => ({
  id: 1, edicao: 'CIOSP 2027', numero: 12, situacao: 'em_analise', adm_responsavel: 7,
  cliente_doc: '12345678000199', cliente_nome: 'Clínica X', tabela_comissao: 13, parcelas: 10,
  credito_status: null, contrato_assinado_em: null, protheus_pedido: null, ...o
});
// Pedido conferido com o checklist completo.
const pronto = (o = {}) => ped({ situacao: 'conferido', credito_status: 'aprovado',
  contrato_assinado_em: AGORA, protheus_pedido: '012345', ...o });

// ---------------------------------------------------------------- assumir

test('assumir: enviado vira em_analise com o ADM responsável', () => {
  const r = F.aplicarAcao(ped({ situacao: 'enviado', adm_responsavel: null }), 'assumir', {}, ctx());
  assert.equal(r.situacao, 'em_analise');
  assert.equal(r.campos.adm_responsavel, 7);
  assert.equal(r.campos.adm_assumiu_em, AGORA);
  assert.equal(r.log.acao, 'assumiu');
});

test('assumir o próprio pedido em análise não muda nada', () => {
  const r = F.aplicarAcao(ped(), 'assumir', {}, ctx());
  assert.equal(r.situacao, 'em_analise');
  assert.deepEqual(r.campos, {});
});

test('assumir pedido de outro ADM exige tomar', () => {
  const semTomar = F.aplicarAcao(ped({ adm_responsavel: 9 }), 'assumir', {}, ctx());
  assert.equal(semTomar.status, 409);
  assert.match(semTomar.erro, /Bruna/);
  assert.match(semTomar.erro, /Tomar/);
  const comTomar = F.aplicarAcao(ped({ adm_responsavel: 9 }), 'assumir', { tomar: true }, ctx());
  assert.equal(comTomar.campos.adm_responsavel, 7);
  assert.equal(comTomar.log.acao, 'tomou');
});

test('quem não é o responsável não age no pedido, mas pode cancelar', () => {
  const r = F.aplicarAcao(ped({ adm_responsavel: 9 }), 'conferir', {}, ctx());
  assert.equal(r.status, 409);
  const c = F.aplicarAcao(ped({ adm_responsavel: 9 }), 'cancelar', { motivo: 'cliente desistiu' }, ctx());
  assert.equal(c.situacao, 'cancelado');
});

// ---------------------------------------------------------------- devolver

test('devolver exige motivo de pelo menos 5 caracteres', () => {
  assert.equal(F.aplicarAcao(ped(), 'devolver', {}, ctx()).status, 400);
  assert.equal(F.aplicarAcao(ped(), 'devolver', { motivo: 'abc' }, ctx()).status, 400);
});

test('devolver depois de conferido zera crédito, contrato e conferência, e mantém o Protheus', () => {
  const r = F.aplicarAcao(pronto({ credito_status: 'recusado' }), 'devolver', { motivo: 'crédito recusado, trocar a forma' }, ctx());
  assert.equal(r.situacao, 'devolvido');
  assert.equal(r.campos.devolvido_motivo, 'crédito recusado, trocar a forma');
  assert.equal(r.campos.credito_status, null);
  assert.equal(r.campos.credito_parecer, null);
  assert.equal(r.campos.contrato_assinado_em, null);
  assert.equal(r.campos.conferido_em, null);
  assert.equal(r.campos.adm_responsavel, null);
  assert.equal('protheus_pedido' in r.campos, false);
  assert.equal(r.log.acao, 'devolveu');
});

test('devolver pedido que ninguém assumiu é situação errada', () => {
  const r = F.aplicarAcao(ped({ situacao: 'enviado', adm_responsavel: null }), 'devolver', { motivo: 'falta o RG' }, ctx());
  assert.equal(r.status, 409);
  assert.match(r.erro, /não dá para/);
});

// ---------------------------------------------------------------- conferir

test('conferir liga o crédito conforme a forma de pagamento', () => {
  const comCredito = F.aplicarAcao(ped(), 'conferir', {}, ctx());
  assert.equal(comCredito.situacao, 'conferido');
  assert.equal(comCredito.campos.credito_status, 'pendente');
  assert.equal(comCredito.campos.conferido_por, 7);
  assert.equal(comCredito.campos.conferido_em, AGORA);
  const semCredito = F.aplicarAcao(ped(), 'conferir', {}, ctx({ forma: { exige_credito: false } }));
  assert.equal(semCredito.campos.credito_status, 'nao_exige');
});

test('conferir recusa quando a linha do painel não fecha', () => {
  const r = F.aplicarAcao(ped(), 'conferir', {}, ctx({ erroPainel: 'Defina a categoria do painel.' }));
  assert.equal(r.status, 400);
  assert.equal(r.erro, 'Defina a categoria do painel.');
});

// ---------------------------------------------------------------- crédito

test('crédito: forma sem crédito, situação errada, recusa sem parecer', () => {
  assert.equal(F.aplicarAcao(pronto({ credito_status: 'nao_exige' }), 'credito', { status: 'aprovado' }, ctx()).status, 400);
  assert.equal(F.aplicarAcao(ped(), 'credito', { status: 'aprovado' }, ctx()).status, 409);
  assert.equal(F.aplicarAcao(pronto({ credito_status: 'pendente' }), 'credito', { status: 'recusado' }, ctx()).status, 400);
  assert.equal(F.aplicarAcao(pronto({ credito_status: 'pendente' }), 'credito', { status: 'talvez' }, ctx()).status, 400);
});

test('crédito aprovado grava quem e quando', () => {
  const r = F.aplicarAcao(pronto({ credito_status: 'pendente' }), 'credito', { status: 'aprovado', parecer: 'ok no Serasa' }, ctx());
  assert.equal(r.situacao, 'conferido');
  assert.equal(r.campos.credito_status, 'aprovado');
  assert.equal(r.campos.credito_parecer, 'ok no Serasa');
  assert.equal(r.campos.credito_por, 7);
  assert.equal(r.log.acao, 'credito');
});

// ---------------------------------------------------------------- contrato e Protheus

test('contrato assinado marca e desmarca', () => {
  const sim = F.aplicarAcao(pronto({ contrato_assinado_em: null }), 'contrato', { assinado: true }, ctx());
  assert.equal(sim.campos.contrato_assinado_por, 7);
  assert.equal(sim.campos.contrato_assinado_em, AGORA);
  assert.equal(sim.log.acao, 'contrato_assinado');
  const nao = F.aplicarAcao(pronto(), 'contrato', { assinado: false }, ctx());
  assert.equal(nao.campos.contrato_assinado_por, null);
  assert.equal(nao.campos.contrato_assinado_em, null);
});

test('nº do Protheus: completa com zeros, recusa formato errado, vazio limpa', () => {
  const r = F.aplicarAcao(pronto({ protheus_pedido: null }), 'protheus', { numero: '12345' }, ctx({ protheusConferido: 'ok' }));
  assert.equal(r.campos.protheus_pedido, '012345');
  assert.equal(r.campos.protheus_conferido, 'ok');
  assert.equal(r.campos.protheus_conferido_em, AGORA);
  assert.equal(F.aplicarAcao(pronto(), 'protheus', { numero: '1234567' }, ctx()).status, 400);
  assert.equal(F.aplicarAcao(pronto(), 'protheus', { numero: '12a45' }, ctx()).status, 400);
  const vazio = F.aplicarAcao(pronto(), 'protheus', { numero: '' }, ctx());
  assert.equal(vazio.campos.protheus_pedido, null);
  assert.equal(vazio.campos.protheus_conferido, null);
});

// ---------------------------------------------------------------- ajustar

test('ajustar a linha do painel valida a categoria', () => {
  assert.equal(F.aplicarAcao(ped(), 'ajustar', { categoria: 'XPTO' }, ctx()).status, 400);
  const r = F.aplicarAcao(ped(), 'ajustar', { categoria: 'DIGITAL', gerente: ' Bia ', equipe: '' }, ctx());
  assert.equal(r.situacao, 'em_analise');
  assert.equal(r.campos.painel_categoria, 'DIGITAL');
  assert.equal(r.campos.painel_gerente, 'Bia');
  assert.equal(r.campos.painel_equipe, null);
  assert.equal(r.log.acao, 'ajustou');
  assert.equal(F.aplicarAcao(ped(), 'ajustar', { categoria: '' }, ctx()).campos.painel_categoria, null);
});

// ---------------------------------------------------------------- finalizar

test('finalizar lista tudo o que falta', () => {
  const r = F.aplicarAcao(ped({ situacao: 'conferido', credito_status: 'pendente' }), 'finalizar', {}, ctx());
  assert.equal(r.status, 400);
  assert.equal(r.erro, 'Falta: crédito aprovado, contrato assinado, nº do pedido no Protheus.');
});

test('finalizar com o checklist completo', () => {
  const r = F.aplicarAcao(pronto(), 'finalizar', {}, ctx());
  assert.equal(r.situacao, 'finalizado');
  assert.equal(r.campos.finalizado_por, 7);
  assert.equal(r.campos.finalizado_em, AGORA);
  assert.equal(r.log.acao, 'finalizou');
  assert.equal(F.aplicarAcao(pronto({ credito_status: 'nao_exige' }), 'finalizar', {}, ctx()).situacao, 'finalizado');
});

test('pendenciasFinalizar', () => {
  assert.deepEqual(F.pendenciasFinalizar(pronto()), []);
  assert.deepEqual(F.pendenciasFinalizar(pronto({ credito_status: 'recusado', protheus_pedido: null })),
    ['crédito aprovado', 'nº do pedido no Protheus']);
});

// ---------------------------------------------------------------- cancelar

test('cancelar exige motivo e, depois de finalizado, a palavra CANCELAR', () => {
  assert.equal(F.aplicarAcao(ped(), 'cancelar', {}, ctx()).status, 400);
  const fin = pronto({ situacao: 'finalizado' });
  assert.equal(F.aplicarAcao(fin, 'cancelar', { motivo: 'cliente desistiu' }, ctx()).status, 400);
  const r = F.aplicarAcao(fin, 'cancelar', { motivo: 'cliente desistiu', confirmacao: 'CANCELAR' }, ctx());
  assert.equal(r.situacao, 'cancelado');
  assert.equal(r.campos.motivo_cancel, 'cliente desistiu');
  assert.equal(r.campos.cancelado_por, 7);
  assert.equal(r.log.acao, 'cancelou');
  assert.equal(F.aplicarAcao(ped({ situacao: 'cancelado' }), 'cancelar', { motivo: 'de novo' }, ctx()).status, 409);
});

test('ação desconhecida é 404', () => {
  assert.equal(F.aplicarAcao(ped(), 'aprovar', {}, ctx()).status, 404);
});

// ---------------------------------------------------------------- vendedor

test('podeEditar: vendedor em rascunho e devolvido; ADM também em análise', () => {
  assert.equal(F.podeEditar('rascunho', false), true);
  assert.equal(F.podeEditar('devolvido', false), true);
  assert.equal(F.podeEditar('em_analise', false), false);
  assert.equal(F.podeEditar('em_analise', true), true);
  assert.equal(F.podeEditar('conferido', true), false);
  assert.equal(F.podeEditar('enviado', false), false);
});

const forma = { id: 4, edicao: 'CIOSP 2027', ativo: true, parcelas_max: 10 };

test('validarEnvio aceita pedido completo, inclusive devolvido', () => {
  assert.deepEqual(F.validarEnvio(ped({ situacao: 'rascunho' }), { forma, qtdItens: 2 }), {});
  assert.deepEqual(F.validarEnvio(ped({ situacao: 'devolvido' }), { forma, qtdItens: 1 }), {});
});

test('validarEnvio recusa o que falta', () => {
  const r = (p, o = {}) => F.validarEnvio(ped({ situacao: 'rascunho', ...p }), { forma, qtdItens: 1, ...o });
  assert.equal(r({ situacao: 'enviado' }).status, 409);
  assert.match(r({ cliente_doc: '123' }).erro, /CPF ou CNPJ/);
  assert.match(r({ cliente_nome: ' ' }).erro, /nome/);
  assert.match(r({}, { qtdItens: 0 }).erro, /item/);
  assert.match(r({}, { forma: null }).erro, /forma de pagamento/);
  assert.match(r({}, { forma: { ...forma, edicao: 'CIOSP 2026' } }).erro, /forma de pagamento/);
  assert.match(r({}, { forma: { ...forma, ativo: false } }).erro, /forma de pagamento/);
  assert.match(r({ tabela_comissao: 12 }).erro, /13% ou 11%/);
  assert.match(r({ parcelas: 12 }).erro, /10 parcelas/);
});

// ---------------------------------------------------------------- Protheus

const appCom = (fn) => ({ services: { Protheus: { connectAndQuery: fn } } });

test('conferirNumeroProtheus: mesmo CNPJ ok, outro divergente, nenhum nao_encontrado, fora do ar nao_conferido', async () => {
  const doc = '12345678000199';
  assert.equal(await F.conferirNumeroProtheus(appCom(async () => [{ cgc: '12.345.678/0001-99' }]), '012345', doc), 'ok');
  assert.equal(await F.conferirNumeroProtheus(appCom(async () => [{ cgc: '99999999000199' }, { cgc: '12345678000199' }]), '012345', doc), 'ok');
  assert.equal(await F.conferirNumeroProtheus(appCom(async () => [{ cgc: '99999999000199' }]), '012345', doc), 'divergente');
  assert.equal(await F.conferirNumeroProtheus(appCom(async () => []), '012345', doc), 'nao_encontrado');
  assert.equal(await F.conferirNumeroProtheus(appCom(async () => { throw new Error('ECONNREFUSED'); }), '012345', doc), 'nao_conferido');
});

test('temPerm consulta as permissões do usuário, incluindo admin', async () => {
  let sql = '';
  const app = { services: { Pg: { connectAndQuery: async (s, p) => { sql = s; return p.id === 7 ? [{ ok: 1 }] : []; } } } };
  assert.equal(await F.temPerm(app, 7, [19004]), true);
  assert.equal(await F.temPerm(app, 8, [19004]), false);
  assert.match(sql, /tab_intranet_usr_permissoes/);
  assert.match(sql, /IN \(0,/);
});

// ---------------------------------------------------------------- forma e tabela do documento

const appForma = (linhas) => ({ services: { Pg: { connectAndQuery: async () => linhas } } });

test('lerForma: sem forma, forma da edição, de outra edição, id inválido', async () => {
  assert.deepEqual(await F.lerForma(appForma([]), null, 'CIOSP 2027'), { forma: null });
  const f = { id: 4, edicao: 'CIOSP 2027', nome: 'Unicred' };
  assert.deepEqual(await F.lerForma(appForma([f]), 4, 'CIOSP 2027'), { forma: f });
  assert.match((await F.lerForma(appForma([f]), 4, 'CIOSP 2026')).erro, /edição/);
  assert.match((await F.lerForma(appForma([]), 99, 'CIOSP 2027')).erro, /edição/);
  assert.match((await F.lerForma(appForma([]), 'abc', 'CIOSP 2027')).erro, /inválida/);
});

test('tabelaComissao só aceita 13 ou 11', () => {
  assert.equal(F.tabelaComissao('13'), 13);
  assert.equal(F.tabelaComissao(11), 11);
  assert.equal(F.tabelaComissao(12), null);
  assert.equal(F.tabelaComissao(null), null);
});

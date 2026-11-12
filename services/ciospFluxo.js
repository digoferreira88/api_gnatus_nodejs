// services/ciospFluxo.js — o caminho do pedido do CIOSP depois que o vendedor termina:
// enviar ao ADM, assumir, conferir ou devolver, crédito, contrato assinado, nº do
// pedido no Protheus, finalizar e cancelar (spec 2026-11-11, seção 6.2).
//
// aplicarAcao() é PURA: recebe o pedido como está e devolve a nova situação e os
// campos a gravar, ou o erro. Quem grava (e mantém a linha do painel coerente) é o
// endpoint, numa transação. Assim cada regra do fluxo tem teste sem banco.

const { documentoValido, soDig, trim } = require('./ciospDocs');
const { CATEGORIAS } = require('./ciospEdicao');

const SITUACOES = ['rascunho', 'enviado', 'em_analise', 'devolvido', 'conferido', 'finalizado', 'cancelado'];
const ACOES_ADM = ['assumir', 'devolver', 'conferir', 'credito', 'contrato', 'protheus', 'ajustar', 'finalizar', 'cancelar'];

const ROTULO = {
  rascunho: 'em rascunho', enviado: 'enviado', em_analise: 'em análise', devolvido: 'devolvido',
  conferido: 'conferido', finalizado: 'finalizado', cancelado: 'cancelado'
};
const VERBO = {
  assumir: 'assumir', devolver: 'devolver', conferir: 'conferir', credito: 'registrar o crédito',
  contrato: 'registrar o contrato', protheus: 'informar o nº do Protheus', ajustar: 'ajustar o painel',
  finalizar: 'finalizar', cancelar: 'cancelar'
};
// Em que situação cada ação do ADM vale.
const DE = {
  assumir: ['enviado', 'em_analise'],
  devolver: ['em_analise', 'conferido'],
  conferir: ['em_analise'],
  credito: ['conferido'],
  contrato: ['conferido'],
  protheus: ['conferido'],
  ajustar: ['em_analise', 'conferido'],
  finalizar: ['conferido'],
  cancelar: SITUACOES.filter(s => s !== 'cancelado')
};

const erro = (status, msg) => ({ status, erro: msg });

// O vendedor mexe no pedido enquanto ele é dele; em análise, só o ADM corrige.
function podeEditar(situacao, ehAdm) {
  if (situacao === 'rascunho' || situacao === 'devolvido') return true;
  return situacao === 'em_analise' && !!ehAdm;
}

// Tudo o que o ADM precisa para começar: cliente identificado, itens, tabela e uma
// forma de pagamento válida da edição.
function validarEnvio(pedido, { forma, qtdItens }) {
  if (!['rascunho', 'devolvido'].includes(pedido.situacao)) {
    return erro(409, `Pedido ${ROTULO[pedido.situacao] || pedido.situacao}: já está com o ADM.`);
  }
  if (!documentoValido(pedido.cliente_doc)) return erro(400, 'Informe o CPF ou CNPJ do cliente.');
  if (!trim(pedido.cliente_nome)) return erro(400, 'Informe o nome do cliente.');
  if (!(Number(qtdItens) >= 1)) return erro(400, 'Inclua pelo menos um item.');
  if (!forma || !forma.ativo || forma.edicao !== pedido.edicao) {
    return erro(400, 'Escolha uma forma de pagamento da edição.');
  }
  if (![13, 11].includes(Number(pedido.tabela_comissao))) return erro(400, 'Escolha a tabela: 13% ou 11%.');
  const parcelas = Number(pedido.parcelas) || 0;
  if (parcelas > 0 && forma.parcelas_max && parcelas > Number(forma.parcelas_max)) {
    return erro(400, `Esta forma de pagamento vai até ${forma.parcelas_max} parcelas.`);
  }
  return {};
}

function pendenciasFinalizar(pedido) {
  const falta = [];
  if (!['aprovado', 'nao_exige'].includes(pedido.credito_status)) falta.push('crédito aprovado');
  if (!pedido.contrato_assinado_em) falta.push('contrato assinado');
  if (!trim(pedido.protheus_pedido)) falta.push('nº do pedido no Protheus');
  return falta;
}

const motivoValido = (m) => { const t = trim(m); return t.length >= 5 && t.length <= 300 ? t : null; };
const texto = (v, max) => trim(v).slice(0, max) || null;

function aplicarAcao(pedido, acao, dados = {}, ctx = {}) {
  if (!ACOES_ADM.includes(acao)) return erro(404, 'Ação desconhecida.');
  const uid = ctx.usuarioId;
  const agora = ctx.agora || new Date();
  const sit = pedido.situacao;

  // Pedido com outro ADM: só quem assumiu age. Os outros tomam explicitamente (e
  // fica registrado). Cancelar é exceção: é raro, exige motivo e vai para o histórico.
  const comOutro = pedido.adm_responsavel != null && Number(pedido.adm_responsavel) !== Number(uid);
  if (comOutro && acao !== 'assumir' && acao !== 'cancelar') {
    return erro(409, `Pedido com ${ctx.nomeResponsavel || 'outro ADM'}. Use Tomar para assumir.`);
  }
  if (!DE[acao].includes(sit)) {
    return erro(409, `Pedido ${ROTULO[sit] || sit}: não dá para ${VERBO[acao]}.`);
  }

  const ok = (situacao, campos, log) => ({ situacao, campos, log });

  switch (acao) {
    case 'assumir': {
      if (sit === 'em_analise' && !comOutro) return ok(sit, {}, { acao: 'assumiu' });
      if (comOutro && !dados.tomar) {
        return erro(409, `Pedido com ${ctx.nomeResponsavel || 'outro ADM'}. Use Tomar para assumir.`);
      }
      return ok('em_analise', { adm_responsavel: uid, adm_assumiu_em: agora },
        { acao: comOutro ? 'tomou' : 'assumiu', para: ctx.nomeUsuario || null });
    }

    case 'devolver': {
      const motivo = motivoValido(dados.motivo);
      if (!motivo) return erro(400, 'Explique ao vendedor o que corrigir (de 5 a 300 caracteres).');
      // A devolução reabre o pedido: crédito e contrato dependem da forma de
      // pagamento, que o vendedor pode trocar. O nº do Protheus fica (o ADM ajusta lá).
      return ok('devolvido', {
        devolvido_motivo: motivo,
        conferido_por: null, conferido_em: null,
        credito_status: null, credito_parecer: null, credito_por: null, credito_em: null,
        contrato_assinado_por: null, contrato_assinado_em: null,
        adm_responsavel: null, adm_assumiu_em: null
      }, { acao: 'devolveu', para: motivo });
    }

    case 'conferir': {
      if (ctx.erroPainel) return erro(400, ctx.erroPainel);
      const exige = !!(ctx.forma && ctx.forma.exige_credito);
      return ok('conferido', {
        conferido_por: uid, conferido_em: agora,
        credito_status: exige ? 'pendente' : 'nao_exige'
      }, { acao: 'conferiu' });
    }

    case 'credito': {
      if (pedido.credito_status === 'nao_exige') return erro(400, 'Esta forma de pagamento não passa por análise de crédito.');
      const status = trim(dados.status);
      if (!['aprovado', 'recusado'].includes(status)) return erro(400, 'Crédito: aprovado ou recusado.');
      const parecer = texto(dados.parecer, 500);
      if (status === 'recusado' && (!parecer || parecer.length < 5)) {
        return erro(400, 'Registre o motivo da recusa do crédito.');
      }
      return ok(sit, { credito_status: status, credito_parecer: parecer, credito_por: uid, credito_em: agora },
        { acao: 'credito', para: status + (parecer ? ` · ${parecer}` : '') });
    }

    case 'contrato': {
      const assinado = dados.assinado === true || dados.assinado === 'true';
      return ok(sit, {
        contrato_assinado_por: assinado ? uid : null,
        contrato_assinado_em: assinado ? agora : null
      }, { acao: 'contrato_assinado', para: assinado ? 'assinado' : 'desmarcado' });
    }

    case 'protheus': {
      const bruto = trim(dados.numero);
      if (!bruto) {
        return ok(sit, { protheus_pedido: null, protheus_conferido: null, protheus_conferido_em: null },
          { acao: 'protheus', para: 'removido' });
      }
      if (!/^\d{1,6}$/.test(bruto)) return erro(400, 'O nº do pedido no Protheus tem até 6 dígitos.');
      const numero = bruto.padStart(6, '0');
      return ok(sit, {
        protheus_pedido: numero,
        protheus_conferido: ctx.protheusConferido || 'nao_conferido',
        protheus_conferido_em: agora
      }, { acao: 'protheus', para: `${numero} · ${ctx.protheusConferido || 'nao_conferido'}` });
    }

    case 'ajustar': {
      const categoria = trim(dados.categoria).toUpperCase() || null;
      if (categoria && !CATEGORIAS.includes(categoria)) {
        return erro(400, `Categoria do painel: ${CATEGORIAS.join(', ')}.`);
      }
      const campos = {
        painel_categoria: categoria,
        painel_gerente: texto(dados.gerente, 120),
        painel_equipe: texto(dados.equipe, 120)
      };
      return ok(sit, campos, { acao: 'ajustou', para: [campos.painel_categoria, campos.painel_gerente, campos.painel_equipe].filter(Boolean).join(' · ') || 'padrão da equipe' });
    }

    case 'finalizar': {
      const falta = pendenciasFinalizar(pedido);
      if (falta.length) return erro(400, `Falta: ${falta.join(', ')}.`);
      return ok('finalizado', { finalizado_por: uid, finalizado_em: agora }, { acao: 'finalizou' });
    }

    case 'cancelar': {
      const motivo = motivoValido(dados.motivo);
      if (!motivo) return erro(400, 'Informe o motivo do cancelamento (de 5 a 300 caracteres).');
      if (sit === 'finalizado' && dados.confirmacao !== 'CANCELAR') {
        return erro(400, 'Pedido finalizado: digite CANCELAR para confirmar.');
      }
      return ok('cancelado', { motivo_cancel: motivo.slice(0, 200), cancelado_por: uid, cancelado_em: agora },
        { acao: 'cancelou', para: motivo });
    }
  }
  return erro(404, 'Ação desconhecida.');
}

// Mesma consulta do middleware requirePerm (perm 0 = admin sempre passa).
async function temPerm(app, userId, perms) {
  if (!userId) return false;
  const lista = (perms || []).map(Number).filter(Number.isFinite);
  const params = { id: Number(userId) };
  lista.forEach((p, i) => { params[`p${i}`] = p; });
  const marcadores = lista.map((_, i) => `@p${i}`).join(',');
  const r = await app.services.Pg.connectAndQuery(
    `SELECT 1 FROM tab_intranet_usr_permissoes
      WHERE id_user = @id AND id_permissao IN (0, ${marcadores || '0'}) LIMIT 1`, params);
  return r.length > 0;
}

// Forma de pagamento escolhida no documento: tem que existir e ser da mesma edição.
// Devolve { forma } (null quando não escolhida) ou { erro }.
async function lerForma(app, id, edicao) {
  if (id == null || id === '') return { forma: null };
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return { erro: 'Forma de pagamento inválida.' };
  const r = await app.services.Pg.connectAndQuery(
    `SELECT id, edicao, nome, coluna_base, desconto_pct, parcelas_max, exige_credito, financeira, ativo
       FROM tab_ciosp_forma_pagto WHERE id = @id`, { id: n });
  if (!r.length || r[0].edicao !== edicao) return { erro: 'Esta forma de pagamento não é da edição do documento.' };
  return { forma: r[0] };
}

const tabelaComissao = (v) => ([13, 11].includes(Number(v)) ? Number(v) : null);

// Confere o nº que o ADM digitou contra o SC5 do Protheus (somente leitura). Nunca
// bloqueia: o resultado vira aviso no checklist.
async function conferirNumeroProtheus(app, numero, doc) {
  try {
    const linhas = await app.services.Protheus.connectAndQuery(`
      SELECT RTRIM(a1.A1_CGC) cgc
        FROM SC5010 c5 WITH (NOLOCK)
        LEFT JOIN SA1010 a1 WITH (NOLOCK)
          ON a1.A1_COD = c5.C5_CLIENTE AND a1.A1_LOJA = c5.C5_LOJACLI
         AND a1.A1_FILIAL IN (c5.C5_FILIAL, '01') AND a1.D_E_L_E_T_ <> '*'
       WHERE c5.C5_NUM = @numero AND c5.D_E_L_E_T_ <> '*'`, { numero });
    if (!linhas || !linhas.length) return 'nao_encontrado';
    const alvo = soDig(doc);
    return linhas.some(l => soDig(l.cgc) === alvo) ? 'ok' : 'divergente';
  } catch (e) {
    console.warn('ciospFluxo/conferirNumeroProtheus:', e.message);
    return 'nao_conferido';
  }
}

module.exports = {
  SITUACOES, ACOES_ADM, ROTULO,
  podeEditar, validarEnvio, pendenciasFinalizar, aplicarAcao,
  temPerm, conferirNumeroProtheus, lerForma, tabelaComissao
};

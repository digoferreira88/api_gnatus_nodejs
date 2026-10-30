// services/qfInspecao.js — inclusão/alteração da inspeção de recebimento (FORM 7.4.3.H).
//
// Regras de quem pode o quê:
//   - Inspetor lança e edita AS PRÓPRIAS inspeções; Qualidade edita qualquer uma.
//   - Ajuste manual de C, P ou N: só Qualidade, com justificativa, e só para um
//     valor que a tabela prevê.
//   - Recebimento bloqueado (decisão 30/10/2026):
//       · fornecedor aguardando PLANO DE AÇÃO (classe C ou D): ninguém lança;
//       · classe D com plano: só inspeção 100% do lote (sem amostragem);
//       · suspenso por outro motivo, reprovado, inativo ou em qualificação: só a
//         Qualidade lança, com justificativa (o material pode chegar e precisa ser
//         registrado — inclusive para ser rejeitado).
//   - P: fornecedor nacional pela data de ENTREGA, importado pela data de COLETA.
//   - Nº do relatório: automático; informar outro número só o administrador.
//   - Alterar exige motivo (trilha). Erro que o registro JÁ tinha (legado da
//     planilha) não impede salvar — só erro novo bloqueia.

const R = require('./qfRegras');
const Core = require('./qfCore');
const Auditoria = require('./auditoria');

const trim = (v) => (v == null ? '' : String(v).trim());
const nul = (v, max) => { const s = trim(v); return s ? (max ? s.slice(0, max) : s) : null; };
const numOuNull = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const dataOuNull = (v) => { const s = trim(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null));

class ErroHttp extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

// corpo da requisição (camelCase) → objeto de trabalho
function normalizar(b) {
  const aj = b.ajustes || {};
  return {
    fornecedorId: Number(b.fornecedorId) || null,
    relInsp: numOuNull(b.relInsp),
    pedidoCompras: nul(b.pedidoCompras, 20), pedidoItem: nul(b.pedidoItem, 4),
    codItem: nul(b.codItem, 30), descricaoItem: nul(b.descricaoItem, 200),
    notaFiscal: nul(b.notaFiscal, 30), lote: nul(b.lote, 60),
    nivelInspecao: nul(b.nivelInspecao, 4),
    qtdRecebida: numOuNull(b.qtdRecebida), qtdInspecionada: numOuNull(b.qtdInspecionada),
    qtdAprovada: numOuNull(b.qtdAprovada), qtdReprovada: numOuNull(b.qtdReprovada),
    especificacao: nul(b.especificacao), criterioAceitacao: nul(b.criterioAceitacao), resultadoDescricao: nul(b.resultadoDescricao),
    instrumentoUtilizado: nul(b.instrumentoUtilizado, 200), rncNumero: nul(b.rncNumero, 40),
    dataEntregaPrevista: dataOuNull(b.dataEntregaPrevista), dataEntregaReal: dataOuNull(b.dataEntregaReal), dataInspecao: dataOuNull(b.dataInspecao),
    ajustes: { c: numOuNull(aj.c), p: numOuNull(aj.p), n: numOuNull(aj.n) },
    ajusteJustificativa: nul(b.ajusteJustificativa),
    observacoes: nul(b.observacoes),
    responsavelNome: nul(b.responsavelNome, 120),
    bloqueioJustificativa: nul(b.bloqueioJustificativa)
  };
}

// Pode receber deste fornecedor? → { permitido, exigeJustificativa, absoluto, motivo }
function situacaoRecebimento(f, niveis) {
  if (!f) return { permitido: false, absoluto: true, motivo: 'Fornecedor não cadastrado no módulo.' };
  const nome = `${f.codigo} – ${f.razao_social}`;
  if (f.status_qualificacao === 'SUSPENSO' && Core.TIPOS_PLANO.includes(f.suspensao_tipo)) {
    return { permitido: false, absoluto: true, motivo: `Recebimento bloqueado: ${nome} está na classe ${f.suspensao_tipo === 'PLANO_ACAO_D' ? 'D' : 'C'} e aguarda o plano de ação, que a Engenharia registra na ficha do fornecedor.` };
  }
  let motivo = null;
  if (!f.ativo) motivo = `${nome} está INATIVO.`;
  else if (!Core.STATUS_ATIVOS.includes(f.status_qualificacao)) motivo = `${nome} está ${f.status_qualificacao.replace(/_/g, ' ')}${f.motivo_suspensao ? ' — ' + String(f.motivo_suspensao).trim().replace(/[.s]+$/, '') : ''}.`;
  if (!motivo) return { permitido: true, inspecao100: !!f.inspecao_100 };
  return niveis && niveis.qualidade
    ? { permitido: true, exigeJustificativa: true, motivo: motivo + ' Só a Qualidade registra, com justificativa.', inspecao100: !!f.inspecao_100 }
    : { permitido: false, motivo: motivo + ' Somente a Qualidade pode registrar o recebimento.' };
}

// linha do banco → mesmo formato (p/ validar o estado anterior e montar o diff)
function deLinha(r) {
  return {
    fornecedorId: r.fornecedor_id, relInsp: r.rel_insp, pedidoCompras: r.pedido_compras, pedidoItem: r.pedido_item,
    codItem: r.cod_item, descricaoItem: r.descricao_item, notaFiscal: r.nota_fiscal, lote: r.lote, nivelInspecao: r.nivel_inspecao,
    qtdRecebida: numOuNull(r.qtd_recebida), qtdInspecionada: numOuNull(r.qtd_inspecionada), qtdAprovada: numOuNull(r.qtd_aprovada), qtdReprovada: numOuNull(r.qtd_reprovada),
    especificacao: r.especificacao, criterioAceitacao: r.criterio_aceitacao, resultadoDescricao: r.resultado_descricao,
    instrumentoUtilizado: r.instrumento_utilizado, rncNumero: r.rnc_numero,
    dataEntregaPrevista: iso(r.data_entrega_prevista), dataEntregaReal: iso(r.data_entrega_real), dataInspecao: iso(r.data_inspecao),
    ajustes: { c: r.c_manual ? numOuNull(r.indice_c) : null, p: r.p_manual ? numOuNull(r.indice_p) : null, n: r.n_manual ? numOuNull(r.indice_n) : null },
    ajusteJustificativa: r.ajuste_justificativa, observacoes: r.observacoes, responsavelNome: r.responsavel_nome
  };
}

// Registro da planilha não tem datas de entrega (o P foi digitado) e o N pode
// conter NC registrada fora da planilha: ao recalcular, P e N originais são
// mantidos (a menos que a Qualidade informe outro valor) e só o C é refeito.
// Usado no salvar E na prévia, para a tela mostrar o mesmo número que será gravado.
function herdarDoLegado(atual, d) {
  if (!atual || atual.origem !== 'PLANILHA') return [];
  const mantidos = [];
  if (d.ajustes.p == null && atual.indice_p != null && !(d.dataEntregaPrevista && d.dataEntregaReal)) { d.ajustes.p = Number(atual.indice_p); mantidos.push('P'); }
  if (d.ajustes.n == null && atual.indice_n != null) { d.ajustes.n = Number(atual.indice_n); mantidos.push('N'); }
  if (mantidos.length && !d.ajusteJustificativa) d.ajusteJustificativa = `${mantidos.join(' e ')} mantido(s) do registro original da planilha FORM 7.4.3.H.`;
  return mantidos;
}

// campos que mudam o cálculo
const CAMPOS_INDICE = ['fornecedorId', 'qtdInspecionada', 'qtdAprovada', 'qtdReprovada', 'rncNumero', 'dataEntregaPrevista', 'dataEntregaReal', 'dataInspecao', 'codItem'];

// Prévia (tela) e cálculo (salvar) usam a mesma função. `d.importado` vem do fornecedor.
async function calcular(Pg, d, { regra, inspecaoId = null, relInsp = null, fornecedor = null } = {}) {
  const rg = regra || await Core.regraAtiva(Pg);
  const janela = await Core.ncsAnteriores(Pg, rg.conteudo, {
    fornecedorId: d.fornecedorId, codItem: d.codItem, dataInspecao: d.dataInspecao || new Date().toISOString().slice(0, 10), relInsp, excluirId: inspecaoId
  });
  const calc = R.calcularInspecao(rg.conteudo, d, janela.ncs);
  const amostra = d.nivelInspecao ? R.amostragem(rg.conteudo, d.nivelInspecao, d.qtdRecebida) : null;
  // item da lista de itens críticos: o fornecedor precisa estar qualificado nessa criticidade
  const itemCrit = d.codItem ? await Core.itemCriticidade(Pg, d.codItem) : null;
  const alertas = [];
  if (itemCrit && fornecedor && !R.normCriticidades(fornecedor.criticidades).includes(itemCrit.criticidade)) {
    alertas.push(`Item crítico ${itemCrit.criticidade} (lista de itens críticos), mas o fornecedor não está qualificado na criticidade ${itemCrit.criticidade} — a Engenharia será avisada (PRO 7.3.7 item 5.2).`);
  }
  return { regra: { id: rg.id, nome: rg.nome }, calc, amostra, itemCriticidade: itemCrit ? itemCrit.criticidade : null, alertas,
    janela: janela.entregas.map(e => ({ relInsp: e.rel_insp, data: iso(e.data_inspecao), nc: e.nc })) };
}

async function salvar(app, req, body, id = null) {
  const { Pg } = app.services;
  const niveis = await Core.niveisDoUsuario(Pg, req);
  const u = Core.usuario(req);
  const d = normalizar(body || {});
  const motivo = nul(body && body.motivo);

  let atual = null;
  if (id) {
    [atual] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_inspecao WHERE id = @id`, { id });
    if (!atual) throw new ErroHttp(404, 'Inspeção não encontrada.');
    if (atual.excluido) throw new ErroHttp(409, 'Inspeção excluída não pode ser alterada.');
    if (!niveis.qualidade && Number(atual.criado_por) !== u.id) throw new ErroHttp(403, 'O inspetor só altera as inspeções que ele mesmo lançou. Peça à Qualidade.');
    if (!motivo) throw new ErroHttp(400, 'Informe o motivo da alteração (fica na trilha de auditoria).');
  }

  // ajuste manual só Qualidade, e só valores previstos na tabela
  const ajustesAntes = atual ? deLinha(atual).ajustes : { c: null, p: null, n: null };
  const ajusteMudou = ['c', 'p', 'n'].some(k => d.ajustes[k] !== ajustesAntes[k]);
  if (ajusteMudou && ['c', 'p', 'n'].some(k => d.ajustes[k] != null) && !niveis.qualidade) throw new ErroHttp(403, 'Ajuste manual de C, P ou N é exclusivo da Qualidade.');

  const [forn] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id: d.fornecedorId || 0 });
  if (!forn) throw new ErroHttp(400, 'Selecione um fornecedor cadastrado no módulo.');
  d.importado = forn.nacional === false;
  // corrigir um registro antigo do mesmo fornecedor não é "receber" de novo
  const novoRecebimento = !atual || atual.fornecedor_id !== forn.id;
  const sit = situacaoRecebimento(forn, niveis);
  if (novoRecebimento) {
    if (!sit.permitido) throw new ErroHttp(403, sit.motivo, { bloqueio: true });
    if (sit.exigeJustificativa && !d.bloqueioJustificativa) throw new ErroHttp(400, sit.motivo + ' Informe a justificativa.', { exigeJustificativa: true });
  }

  // regra: inclusão usa a ativa; alteração recalcula com a ativa SÓ se mexeu em campo do cálculo
  const regraAtiva = await Core.regraAtiva(Pg);
  const antes = atual ? deLinha(atual) : null;
  const mexeuNoCalculo = !atual || ajusteMudou || CAMPOS_INDICE.some(k => String(antes[k] ?? '') !== String(d[k] ?? ''));

  if (atual && mexeuNoCalculo) herdarDoLegado(atual, d);
  const ajustou = ['c', 'p', 'n'].filter(k => d.ajustes[k] != null);
  for (const k of ajustou) {
    const permitidos = R.valoresPermitidos(regraAtiva.conteudo, k.toUpperCase());
    if (!permitidos.includes(d.ajustes[k])) throw new ErroHttp(400, `Índice ${k.toUpperCase()} = ${d.ajustes[k]} não existe na tabela vigente (${permitidos.join(' / ')}).`);
  }

  // validação: erro pré-existente (registro legado) não bloqueia; erro novo bloqueia
  const erros = R.validarInspecao(d, { inspecao100: novoRecebimento && !!forn.inspecao_100 });
  const errosAntes = antes ? R.validarInspecao({ ...antes, importado: d.importado }) : [];
  const errosNovos = erros.filter(e => !errosAntes.includes(e));
  if (errosNovos.length) throw new ErroHttp(400, errosNovos[0], { erros: errosNovos });

  let relInsp = atual ? atual.rel_insp : null;
  if (d.relInsp && d.relInsp !== relInsp) {
    if (!niveis.admin) throw new ErroHttp(403, 'Somente o administrador do módulo define o nº do relatório manualmente.');
    relInsp = d.relInsp;
  }

  let ind;
  let regraId;
  if (mexeuNoCalculo) {
    const r = await calcular(Pg, d, { regra: regraAtiva, inspecaoId: id, relInsp: relInsp, fornecedor: forn });
    ind = { pct_conforme: r.calc.pctConforme, dias_atraso: r.calc.diasAtraso, nc: r.calc.nc, ncs_janela: r.calc.ncsJanela,
      indice_c: r.calc.indiceC, indice_p: r.calc.indiceP, indice_n: r.calc.indiceN, iqf: r.calc.iqf,
      c_manual: r.calc.manual.c, p_manual: r.calc.manual.p, n_manual: r.calc.manual.n };
    regraId = regraAtiva.id;
    if (ind.iqf == null) throw new ErroHttp(400, 'Não foi possível calcular o IQF — confira quantidades e datas.');
  } else {
    ind = { pct_conforme: atual.pct_conforme, dias_atraso: atual.dias_atraso, nc: atual.nc, ncs_janela: atual.ncs_janela,
      indice_c: atual.indice_c, indice_p: atual.indice_p, indice_n: atual.indice_n, iqf: atual.iqf,
      c_manual: atual.c_manual, p_manual: atual.p_manual, n_manual: atual.n_manual };
    regraId = atual.regra_versao_id;
  }

  const itemCrit = d.codItem ? await Core.itemCriticidade(Pg, d.codItem) : null;
  const campos = {
    fornecedor_id: forn.id, fornecedor_codigo: forn.codigo, fornecedor_nome: forn.razao_social,
    item_criticidade: itemCrit ? itemCrit.criticidade : null,
    tipo_prazo: d.importado ? 'COLETA' : 'ENTREGA',
    bloqueio_justificativa: novoRecebimento && sit.exigeJustificativa ? d.bloqueioJustificativa : (atual ? atual.bloqueio_justificativa : null),
    pedido_compras: d.pedidoCompras, pedido_item: d.pedidoItem, cod_item: d.codItem, descricao_item: d.descricaoItem,
    nota_fiscal: d.notaFiscal, lote: d.lote, nivel_inspecao: d.nivelInspecao,
    qtd_recebida: d.qtdRecebida, qtd_inspecionada: d.qtdInspecionada, qtd_aprovada: d.qtdAprovada, qtd_reprovada: d.qtdReprovada,
    especificacao: d.especificacao, criterio_aceitacao: d.criterioAceitacao, resultado_descricao: d.resultadoDescricao,
    instrumento_utilizado: d.instrumentoUtilizado, rnc_numero: d.rncNumero,
    data_entrega_prevista: d.dataEntregaPrevista, data_entrega_real: d.dataEntregaReal, data_inspecao: d.dataInspecao,
    ajuste_justificativa: ajustou.length ? d.ajusteJustificativa : null,
    observacoes: d.observacoes,
    responsavel_nome: atual ? (d.responsavelNome || atual.responsavel_nome) : (u.nome || d.responsavelNome),
    regra_versao_id: regraId, ...ind
  };

  let salvo;
  if (!atual) {
    for (let tentativa = 0; tentativa < 4 && !salvo; tentativa++) {
      const numero = relInsp || await Core.proximoRelInsp(Pg);
      try {
        [salvo] = await Pg.connectAndQuery(
          `INSERT INTO tab_qf_inspecao (rel_insp, ${Object.keys(campos).join(', ')}, responsavel_id, origem, criado_por, atualizado_por)
           VALUES (@rel_insp, ${Object.keys(campos).map(k => '@' + k).join(', ')}, @uid, 'INTRANET', @uid, @uid)
           RETURNING *`, { ...campos, rel_insp: numero, uid: u.id });
      } catch (e) {
        if (e.code === '23505' && !relInsp) continue;           // outro inspetor pegou o mesmo número: tenta o próximo
        if (e.code === '23505') throw new ErroHttp(409, `O relatório nº ${numero} já existe.`);
        throw e;
      }
    }
    if (!salvo) throw new ErroHttp(409, 'Não foi possível reservar um número de relatório. Tente de novo.');
    await Core.log(Pg, req, {
      entidade: 'inspecao', entidadeId: salvo.id, fornecedorId: forn.id, acao: 'CRIAR',
      mudancas: [{ campo: 'rel_insp', para: salvo.rel_insp }, { campo: 'iqf', para: salvo.iqf }, { campo: 'indices', para: `C=${salvo.indice_c} P=${salvo.indice_p} N=${salvo.indice_n}` }]
        .concat(ajustou.map(k => ({ campo: `indice_${k}_manual`, para: d.ajustes[k] })))
    });
  } else {
    const sets = Object.keys(campos).map(k => `${k} = @${k}`).join(', ');
    [salvo] = await Pg.connectAndQuery(
      `UPDATE tab_qf_inspecao SET ${sets}, rel_insp = @rel_insp, atualizado_por = @uid, atualizado_em = NOW() WHERE id = @id RETURNING *`,
      { ...campos, rel_insp: relInsp, uid: u.id, id });
    const mud = Core.diff(atual, salvo, ['rel_insp', ...Object.keys(campos)]);
    await Core.log(Pg, req, { entidade: 'inspecao', entidadeId: salvo.id, fornecedorId: forn.id, acao: 'ALTERAR', mudancas: mud, motivo });
    Auditoria.registrar(app, {
      modulo: 'Qualidade', submodulo: 'Inspeção de recebimento', acao: 'ALTERAR', severidade: 'AVISO', req,
      entidade: 'inspecao', entidadeId: String(salvo.id),
      descricao: `Alterou o relatório ${salvo.rel_insp} (${forn.codigo}) — ${mud.map(m => m.campo).join(', ')} · motivo: ${motivo}`
    });
  }

  // IQF materializado (+ ações de classe); se trocou de fornecedor, recalcula os dois
  const recalc = await Core.recalcularFornecedor(app, forn.id, { req });
  if (atual && atual.fornecedor_id !== forn.id) await Core.recalcularFornecedor(app, atual.fornecedor_id, { req });

  // item crítico de fornecedor sem qualificação nessa criticidade → Engenharia (PRO 5.2)
  if (itemCrit && !R.normCriticidades(forn.criticidades).includes(itemCrit.criticidade)) {
    const cfgI = await Core.config(Pg);
    await Core.notificar(app, {
      chave: `item_critico|${forn.id}|${itemCrit.criticidade}|${new Date().toISOString().slice(0, 10)}`, tipo: 'ITEM_CRITICO', entidade: 'inspecao', entidadeId: salvo.id, fornecedorId: forn.id,
      para: cfgI.emails_engenharia,
      assunto: `[Item crítico ${itemCrit.criticidade}] ${forn.codigo} – ${forn.razao_social} não está qualificado nessa criticidade`,
      texto: `O recebimento ${salvo.rel_insp} trouxe o item ${salvo.cod_item}${itemCrit.descricao ? ' (' + itemCrit.descricao + ')' : ''}, que está na lista de itens críticos como ${itemCrit.criticidade}.
O fornecedor ${forn.codigo} – ${forn.razao_social} não tem a criticidade ${itemCrit.criticidade} na qualificação (tem: ${R.normCriticidades(forn.criticidades).join(', ') || 'nenhuma — não crítico'}).
Avalie incluir a criticidade e abrir a qualificação correspondente (PRO 7.3.7 itens 5.2 e 5.3).`
    });
  }

  if (salvo.nc && (!atual || !atual.nc)) {
    const cfg = await Core.config(Pg);
    await Core.notificar(app, {
      chave: `inspecao_nc|${salvo.id}`, tipo: 'INSPECAO_NC', entidade: 'inspecao', entidadeId: salvo.id, fornecedorId: forn.id,
      para: cfg.emails_qualidade,
      assunto: `[Inspeção reprovada] Rel. ${salvo.rel_insp} — ${forn.codigo} ${forn.razao_social}`,
      texto: `Relatório de inspeção ${salvo.rel_insp} com não conformidade.\nFornecedor: ${forn.codigo} – ${forn.razao_social}\nItem: ${salvo.cod_item || '—'} · NF ${salvo.nota_fiscal || '—'} · PC ${salvo.pedido_compras || '—'}\nAprovadas ${salvo.qtd_aprovada} · reprovadas ${salvo.qtd_reprovada} de ${salvo.qtd_inspecionada} inspecionadas · RNC ${salvo.rnc_numero || '—'}\nIQF da entrega: ${salvo.iqf} (C ${salvo.indice_c} × P ${salvo.indice_p} × N ${salvo.indice_n})\nResponsável: ${salvo.responsavel_nome || '—'}`
    });
  }

  return { inspecao: salvo, fornecedor: recalc };
}

async function excluir(app, req, id, motivo) {
  const { Pg } = app.services;
  if (!trim(motivo)) throw new ErroHttp(400, 'Informe o motivo da exclusão.');
  const [atual] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_inspecao WHERE id = @id`, { id });
  if (!atual) throw new ErroHttp(404, 'Inspeção não encontrada.');
  if (atual.excluido) throw new ErroHttp(409, 'Inspeção já excluída.');
  const u = Core.usuario(req);
  await Pg.connectAndQuery(
    `UPDATE tab_qf_inspecao SET excluido = TRUE, excluido_motivo = @m, excluido_por = @u, excluido_em = NOW(), atualizado_por = @u, atualizado_em = NOW() WHERE id = @id`,
    { id, m: trim(motivo), u: u.id });
  await Core.log(Pg, req, { entidade: 'inspecao', entidadeId: id, fornecedorId: atual.fornecedor_id, acao: 'EXCLUIR', mudancas: [{ campo: 'excluido', de: false, para: true }], motivo });
  Auditoria.registrar(app, {
    modulo: 'Qualidade', submodulo: 'Inspeção de recebimento', acao: 'EXCLUIR', severidade: 'ALERTA', req,
    entidade: 'inspecao', entidadeId: String(id), descricao: `Excluiu o relatório ${atual.rel_insp} (${atual.fornecedor_codigo}) — motivo: ${trim(motivo)}`
  });
  const recalc = await Core.recalcularFornecedor(app, atual.fornecedor_id, { req });
  return { ok: true, fornecedor: recalc };
}

module.exports = { ErroHttp, normalizar, deLinha, herdarDoLegado, situacaoRecebimento, calcular, salvar, excluir };

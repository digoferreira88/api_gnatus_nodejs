// Lógica do módulo Cobrança Omni: grava importação (idempotente por tipo+data),
// lê a carteira atual (última importação + camada de trabalho), dashboard, detalhe
// e grava o trabalho (status/tags/agendamento + histórico de ação). 100% Postgres.
const { STATUS_SET, STATUS_LIST, FAIXAS } = require('./omniStatus');

const soma = (arr, campo) => +arr.reduce((s, l) => s + (Number(l[campo]) || 0), 0).toFixed(2);
const quem = (user) => String((user && (user.EMAIL || user.NOME)) || 'sistema').slice(0, 120);

// Salva uma importação: apaga a anterior do mesmo tipo+data (cascade), insere header +
// posições, faz upsert da camada de trabalho e marca quem saiu da carteira.
async function salvarImportacao(app, { parsed, dataRef, arquivoNome, user }) {
  const { Pg } = app.services;
  const tipo = parsed.tipo;
  const por = quem(user);
  const data = dataRef || parsed.periodo_fim || new Date().toISOString().slice(0, 10);
  const linhas = parsed.linhas || [];
  if (!linhas.length) return { ok: false, erro: 'VAZIO', message: 'Nenhum contrato encontrado no arquivo.' };

  // idempotência: remove importação anterior do mesmo tipo+data (cascade apaga posições)
  await Pg.connectAndQuery(`DELETE FROM tab_omni_import WHERE tipo=@t AND data_ref=@d::date`, { t: tipo, d: data });

  const totalContratos = linhas.length;
  const totalAtrasado = soma(linhas, 'valor_atrasado');
  const totalRecebido = soma(linhas, 'valor_recebido_mes');

  // conjunto já existente (p/ contar novos) — por tipo
  const existRows = await Pg.connectAndQuery(`SELECT contrato FROM tab_omni_contrato WHERE tipo=@t`, { t: tipo });
  const existentes = new Set(existRows.map((r) => r.contrato));
  const novos = linhas.filter((l) => !existentes.has(l.contrato)).length;

  const imp = (await Pg.connectAndQuery(
    `INSERT INTO tab_omni_import (tipo, arquivo_nome, data_ref, periodo_ini, periodo_fim, total_contratos, total_atrasado, total_recebido, novos, criado_por)
     VALUES (@tipo,@nome,@data::date,@pi,@pf,@tc,@ta,@tr,@nv,@por) RETURNING id`,
    { tipo, nome: String(arquivoNome || '').slice(0, 300), data, pi: parsed.periodo_ini, pf: parsed.periodo_fim,
      tc: totalContratos, ta: totalAtrasado, tr: totalRecebido, nv: novos, por }))[0];
  const importId = imp.id;

  for (const l of linhas) {
    await Pg.connectAndQuery(
      `INSERT INTO tab_omni_posicao
        (import_id, tipo, data_ref, contrato, cpf, cliente, cidade_uf, produto, parcela, atraso_dias, faixa,
         valor_atrasado, valor_recebido_mes, pct_recebido, dias_sem_acionamento, situacao_portal, score, pdd_fechamento,
         telefone, emissao, proposta, vlr_financiado, vlr_liquido, data_recompra, valor_recompra)
       VALUES (@imp,@tipo,@data::date,@contrato,@cpf,@cliente,@cidade,@produto,@parcela,@atraso,@faixa,
         @vatr,@vrec,@pct,@dsa,@sitp,@score,@pdd,@tel,@emissao,@proposta,@vfin,@vliq,@drec,@vrecompra)`,
      { imp: importId, tipo, data,
        contrato: l.contrato, cpf: l.cpf || null, cliente: l.cliente || null, cidade: l.cidade_uf || null,
        produto: l.produto || null, parcela: l.parcela || null, atraso: l.atraso_dias ?? null, faixa: l.faixa || null,
        vatr: l.valor_atrasado ?? null, vrec: l.valor_recebido_mes ?? null, pct: l.pct_recebido ?? null,
        dsa: l.dias_sem_acionamento ?? null, sitp: l.situacao_portal || null, score: l.score || null,
        pdd: l.pdd_fechamento ?? null, tel: l.telefone || null, emissao: l.emissao || null, proposta: l.proposta || null,
        vfin: l.vlr_financiado ?? null, vliq: l.vlr_liquido ?? null, drec: l.data_recompra || null, vrecompra: l.valor_recompra ?? null });

    await Pg.connectAndQuery(
      `INSERT INTO tab_omni_contrato (contrato, tipo, cpf, cliente, na_carteira, primeiro_em, ultimo_em, saiu_em)
       VALUES (@c,@t,@cpf,@cli,TRUE,@d::date,@d::date,NULL)
       ON CONFLICT (contrato) DO UPDATE SET
         tipo=@t,
         cpf=COALESCE(NULLIF(@cpf,''), tab_omni_contrato.cpf),
         cliente=COALESCE(@cli, tab_omni_contrato.cliente),
         na_carteira=TRUE, ultimo_em=@d::date, saiu_em=NULL, atualizado_em=NOW()`,
      { c: l.contrato, t: tipo, cpf: l.cpf || '', cli: l.cliente || null, d: data });
  }

  // marca quem saiu: estava na carteira, não veio nesta importação (ultimo_em < data)
  let sairam = 0;
  const outRows = await Pg.connectAndQuery(
    `UPDATE tab_omni_contrato SET na_carteira=FALSE, saiu_em=@d::date, atualizado_em=NOW()
      WHERE tipo=@t AND na_carteira=TRUE AND ultimo_em < @d::date RETURNING contrato`, { t: tipo, d: data });
  sairam = outRows.length;
  await Pg.connectAndQuery(`UPDATE tab_omni_import SET sairam=@s WHERE id=@id`, { s: sairam, id: importId });

  return { ok: true, importId, tipo, dataRef: data, totalContratos, totalAtrasado, totalRecebido, novos, sairam };
}

// Cabeçalho da última importação de um tipo.
async function ultimoImport(app, tipo) {
  const { Pg } = app.services;
  return (await Pg.connectAndQuery(
    `SELECT id, tipo, arquivo_nome, data_ref, periodo_ini, periodo_fim, total_contratos, total_atrasado,
            total_recebido, novos, sairam, criado_por, criado_em
       FROM tab_omni_import WHERE tipo=@t ORDER BY data_ref DESC, id DESC LIMIT 1`, { t: tipo }))[0] || null;
}

// Carteira atual = posições da última importação (tipo) + camada de trabalho + nº de ações.
async function listarCarteira(app, { tipo = 'CARTEIRA', faixa, status, score, semAcionamento, q }) {
  const { Pg } = app.services;
  const imp = await ultimoImport(app, tipo);
  if (!imp) return { importacao: null, contratos: [], statusLista: STATUS_LIST, faixas: FAIXAS };

  const cond = ['p.import_id = @imp'];
  const params = { imp: imp.id };
  if (faixa) { cond.push('p.faixa = @faixa'); params.faixa = faixa; }
  if (status) { cond.push('COALESCE(c.status,\'\') = @status'); params.status = status; }
  if (score) { cond.push('p.score = @score'); params.score = score; }
  if (semAcionamento != null && semAcionamento !== '') { cond.push('p.dias_sem_acionamento >= @dsa'); params.dsa = parseInt(semAcionamento, 10) || 0; }
  if (q) { cond.push('(p.cliente ILIKE @q OR p.contrato ILIKE @q OR p.cpf ILIKE @q)'); params.q = `%${String(q).trim()}%`; }

  const rows = await Pg.connectAndQuery(
    `SELECT p.contrato, p.cpf, p.cliente, p.cidade_uf, p.produto, p.parcela, p.atraso_dias, p.faixa,
            p.valor_atrasado, p.valor_recebido_mes, p.pct_recebido, p.dias_sem_acionamento, p.situacao_portal,
            p.score, p.pdd_fechamento, p.telefone,
            p.emissao, p.proposta, p.vlr_financiado, p.vlr_liquido, p.data_recompra, p.valor_recompra,
            COALESCE(c.status,'') AS status, COALESCE(c.tags,'[]'::jsonb) AS tags,
            c.agendamento_data, c.agendamento_obs, c.na_carteira, c.primeiro_em, c.atualizado_em,
            (SELECT COUNT(*) FROM tab_omni_acao a WHERE a.contrato = p.contrato) AS n_acoes,
            (SELECT MAX(a.criado_em) FROM tab_omni_acao a WHERE a.contrato = p.contrato) AS ultima_acao
       FROM tab_omni_posicao p
       LEFT JOIN tab_omni_contrato c ON c.contrato = p.contrato
      WHERE ${cond.join(' AND ')}
      ORDER BY p.valor_atrasado DESC NULLS LAST`, params);

  return { importacao: imp, contratos: rows, statusLista: STATUS_LIST, faixas: FAIXAS };
}

// Dashboard: recuperação + envelhecimento (foco pedido pelo setor).
async function dashboard(app, { tipo = 'CARTEIRA' }) {
  const { Pg } = app.services;
  const imp = await ultimoImport(app, tipo);
  if (!imp) return { importacao: null };

  const porFaixa = await Pg.connectAndQuery(
    `SELECT faixa, COUNT(*)::int AS qtd, COALESCE(SUM(valor_atrasado),0) AS valor_atrasado,
            COALESCE(SUM(valor_recebido_mes),0) AS valor_recebido
       FROM tab_omni_posicao WHERE import_id=@imp GROUP BY faixa ORDER BY faixa`, { imp: imp.id });
  const porScore = await Pg.connectAndQuery(
    `SELECT COALESCE(NULLIF(score,''),'(sem)') AS score, COUNT(*)::int AS qtd, COALESCE(SUM(valor_atrasado),0) AS valor
       FROM tab_omni_posicao WHERE import_id=@imp GROUP BY COALESCE(NULLIF(score,''),'(sem)') ORDER BY score`, { imp: imp.id });
  const porStatus = await Pg.connectAndQuery(
    `SELECT COALESCE(NULLIF(c.status,''),'(sem status)') AS status, COUNT(*)::int AS qtd,
            COALESCE(SUM(p.valor_atrasado),0) AS valor
       FROM tab_omni_posicao p LEFT JOIN tab_omni_contrato c ON c.contrato=p.contrato
      WHERE p.import_id=@imp GROUP BY COALESCE(NULLIF(c.status,''),'(sem status)') ORDER BY qtd DESC`, { imp: imp.id });
  // envelhecimento: evolução do valor atrasado por faixa nas últimas importações
  const serie = await Pg.connectAndQuery(
    `SELECT i.data_ref, i.total_atrasado, i.total_recebido, i.total_contratos,
            COALESCE(SUM(p.valor_atrasado) FILTER (WHERE p.faixa='1 a 30'),0)  AS f1,
            COALESCE(SUM(p.valor_atrasado) FILTER (WHERE p.faixa='31 a 60'),0) AS f2,
            COALESCE(SUM(p.valor_atrasado) FILTER (WHERE p.faixa='61 a 90'),0) AS f3
       FROM tab_omni_import i LEFT JOIN tab_omni_posicao p ON p.import_id=i.id
      WHERE i.tipo=@t
      GROUP BY i.id, i.data_ref, i.total_atrasado, i.total_recebido, i.total_contratos
      ORDER BY i.data_ref DESC LIMIT 30`, { t: tipo });

  return { importacao: imp, porFaixa, porScore, porStatus, serie: serie.reverse() };
}

// Detalhe de um contrato + histórico de ações.
async function detalhe(app, contrato) {
  const { Pg } = app.services;
  const c = String(contrato || '').replace(/\D/g, '');
  const pos = (await Pg.connectAndQuery(
    `SELECT p.* FROM tab_omni_posicao p
      WHERE p.contrato=@c ORDER BY p.data_ref DESC LIMIT 1`, { c }))[0] || null;
  const trab = (await Pg.connectAndQuery(
    `SELECT contrato, tipo, cpf, cliente, status, tags, agendamento_data, agendamento_obs,
            na_carteira, primeiro_em, ultimo_em, saiu_em, atualizado_por, atualizado_em
       FROM tab_omni_contrato WHERE contrato=@c`, { c }))[0] || null;
  const acoes = await Pg.connectAndQuery(
    `SELECT id, texto, status_anterior, status_novo, agendamento_data, autor, concluida, concluida_em, criado_em
       FROM tab_omni_acao WHERE contrato=@c ORDER BY criado_em DESC LIMIT 200`, { c });
  return { contrato: c, posicao: pos, trabalho: trab, acoes, statusLista: STATUS_LIST };
}

// Grava o trabalho: atualiza status/tags/agendamento e registra a ação no histórico.
async function salvarTrabalho(app, { contrato, status, tags, agendamentoData, agendamentoObs, observacao, user }) {
  const { Pg } = app.services;
  const c = String(contrato || '').replace(/\D/g, '');
  if (!c) return { ok: false, erro: 'CONTRATO', message: 'Contrato inválido.' };
  if (status && !STATUS_SET.has(status)) return { ok: false, erro: 'STATUS', message: 'Status inválido.' };
  const por = quem(user);

  const atualRow = (await Pg.connectAndQuery(`SELECT status FROM tab_omni_contrato WHERE contrato=@c`, { c }))[0];
  if (!atualRow) return { ok: false, erro: 'NAO_ENCONTRADO', message: 'Contrato não está na base (importe a carteira primeiro).' };
  const statusAnterior = atualRow.status || '';
  const statusNovo = status != null ? status : statusAnterior;
  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags.map((t) => String(t).slice(0, 40)).filter(Boolean)) : null;

  await Pg.connectAndQuery(
    `UPDATE tab_omni_contrato SET
        status = @st,
        tags = COALESCE(@tags::jsonb, tags),
        agendamento_data = @ag::date,
        agendamento_obs = @agobs,
        atualizado_por = @por, atualizado_em = NOW()
      WHERE contrato=@c`,
    { c, st: statusNovo, tags: tagsJson, ag: agendamentoData || null, agobs: agendamentoObs || null, por });

  const houveMudancaStatus = status != null && statusNovo !== statusAnterior;
  if (houveMudancaStatus || (observacao && observacao.trim()) || agendamentoData) {
    await Pg.connectAndQuery(
      `INSERT INTO tab_omni_acao (contrato, texto, status_anterior, status_novo, agendamento_data, autor, id_user)
       VALUES (@c,@texto,@sa,@sn,@ag::date,@por,@uid)`,
      { c, texto: (observacao || '').trim() || null, sa: statusAnterior || null,
        sn: houveMudancaStatus ? statusNovo : null, ag: agendamentoData || null, por,
        uid: (user && user.ID) || null });
  }
  return { ok: true, contrato: c, status: statusNovo };
}

module.exports = { salvarImportacao, listarCarteira, dashboard, detalhe, salvarTrabalho, ultimoImport };

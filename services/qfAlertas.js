// services/qfAlertas.js — job diário da Qualificação de Fornecedores (só fornecedor crítico):
//
//   Documentos (PRO 5.4 / 5.11)
//   - vencendo em N dias (dias_alerta_documento, padrão 30 e 1) → avisa Engenharia e o
//     fornecedor (o e-mail externo só sai com `email_fornecedor` ligado);
//   - obrigatório vencido, ou protocolo com prazo de regularização vencido → avisa e, com
//     `suspender_doc_vencido`, SUSPENDE o fornecedor (tipo DOCUMENTO).
//   Requalificação anual (PRO 5.10)
//   - vence em N dias (dias_alerta_requalificacao, padrão 60 e 30) → avisa a Engenharia
//     para iniciar (PRO 5.10.1: no mínimo 30 dias antes);
//   - vencida sem requalificação aprovada → SUSPENDE até a conclusão (Nota 3), com
//     `suspender_requalificacao_vencida`.
//
// Idempotente: a chave de tab_qf_notificacao impede repetir o aviso. Dormente sem
// QF_ALERTAS_ATIVO=1 (ver services/scheduler.js).

const Core = require('./qfCore');

const fmt = (d) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—');

async function rodarDocumentos(app, cfg, stats) {
  const { Pg } = app.services;
  const situacao = await Core.situacaoDocsCriticos(Pg);
  const marcos = [...new Set(cfg.dias_alerta_documento)].sort((a, b) => b - a);
  for (const s of situacao.values()) {
    const f = s.fornecedor;
    for (const i of s.itens) {
      const doc = i.documento;
      if (!doc) continue;
      if (i.venceEm != null && ['VENCENDO', 'OK', 'PROTOCOLADO'].includes(i.situacao)) {
        const marco = marcos.filter(m => i.venceEm <= m).pop();
        if (marco == null) continue;
        const coluna = marco >= 30 ? 'aviso_30_em' : 'aviso_1_em';
        const oque = i.situacao === 'PROTOCOLADO' ? 'prazo do protocolo' : 'validade';
        const data = i.situacao === 'PROTOCOLADO' ? doc.prazo_regularizacao : doc.data_validade;
        const r = await Core.notificar(app, {
          chave: `doc_vencendo|${doc.id}|${marco}|${String(data).slice(0, 10)}`, tipo: 'DOCUMENTO_VENCENDO', entidade: 'documento', entidadeId: doc.id, fornecedorId: f.id,
          para: cfg.emails_engenharia, assunto: `[Documento: ${oque} em ${i.venceEm} dia(s)] ${f.codigo} – ${f.razao_social}: ${i.nome}`,
          texto: `O documento "${i.nome}" do fornecedor ${f.codigo} – ${f.razao_social} tem ${oque} em ${fmt(data)} (${i.venceEm} dia(s)).\nSolicite o documento ao fornecedor para não suspender a qualificação (PRO 7.3.7 item 5.11).`
        });
        if (!r.duplicada) {
          stats.avisosDocumento++;
          await Pg.connectAndQuery(`UPDATE tab_qf_documento SET ${coluna} = NOW() WHERE id = @id`, { id: doc.id });
          if (f.contato_email) {
            await Core.notificar(app, {
              chave: `doc_vencendo_forn|${doc.id}|${marco}|${String(data).slice(0, 10)}`, tipo: 'DOCUMENTO_VENCENDO_FORNECEDOR', entidade: 'documento', entidadeId: doc.id, fornecedorId: f.id,
              para: [f.contato_email], externo: true, assunto: `GNATUS — documento de qualificação: ${i.nome} (${fmt(data)})`,
              texto: `Prezado fornecedor,\n\nO documento "${i.nome}" de ${f.razao_social}, cadastrado na qualificação de fornecedores da GNATUS, ${i.situacao === 'PROTOCOLADO' ? 'foi apresentado por protocolo com prazo de entrega em' : 'vence em'} ${fmt(data)}.\nPor favor, envie o documento válido (ou o protocolo de renovação) respondendo a este e-mail.\n\nAtenciosamente,\nEngenharia — GNATUS`
            });
          }
        }
      }
      if (['VENCIDO', 'PROTOCOLO_VENCIDO'].includes(i.situacao) && !doc.aviso_vencido_em) {
        let suspenso = false;
        if (i.regra === 'OBRIGATORIO' && cfg.suspender_doc_vencido && Core.STATUS_ATIVOS.includes(f.status_qualificacao)) {
          const motivo = i.situacao === 'PROTOCOLO_VENCIDO'
            ? `Protocolo de "${i.nome}" sem o documento definitivo até ${fmt(doc.prazo_regularizacao)} (PRO 7.3.7 itens 5.4 e 5.11).`
            : `Documento obrigatório vencido em ${fmt(doc.data_validade)} sem regularização: ${i.nome} (PRO 7.3.7 item 5.11).`;
          suspenso = await Core.suspender(app, f, motivo, null, 'DOCUMENTO');
          if (suspenso) { stats.suspensos++; f.status_qualificacao = 'SUSPENSO'; }
        }
        await Core.notificar(app, {
          chave: `doc_vencido|${doc.id}`, tipo: 'DOCUMENTO_VENCIDO', entidade: 'documento', entidadeId: doc.id, fornecedorId: f.id,
          para: [...cfg.emails_engenharia, ...cfg.emails_qualidade],
          assunto: `[Documento vencido] ${f.codigo} – ${f.razao_social}: ${i.nome}${suspenso ? ' — fornecedor SUSPENSO' : ''}`,
          texto: `O documento "${i.nome}" do fornecedor ${f.codigo} – ${f.razao_social} está vencido (${i.situacao === 'PROTOCOLO_VENCIDO' ? 'prazo do protocolo' : 'validade'}).${suspenso ? '\nA qualificação foi SUSPENSA até a regularização.' : ''}`
        });
        await Pg.connectAndQuery(`UPDATE tab_qf_documento SET aviso_vencido_em = NOW() WHERE id = @id`, { id: doc.id });
        stats.avisosVencidos++;
      }
    }
  }
}

async function rodarRequalificacao(app, cfg, stats) {
  const { Pg } = app.services;
  const linhas = await Pg.connectAndQuery(
    `SELECT f.*, (f.qualificacao_valida_ate - CURRENT_DATE)::int AS dias,
            (SELECT id FROM tab_qf_qualificacao q WHERE q.fornecedor_id = f.id AND q.tipo = 'REQUALIFICACAO' AND q.status IN ('EM_ANDAMENTO','PAUSADO') LIMIT 1) AS processo_aberto
       FROM tab_qf_fornecedor f
      WHERE cardinality(f.criticidades) > 0 AND f.ativo AND f.qualificacao_valida_ate IS NOT NULL`);
  const marcos = [...new Set(cfg.dias_alerta_requalificacao)].sort((a, b) => b - a);
  for (const f of linhas) {
    const nome = `${f.codigo} – ${f.razao_social}`;
    if (f.dias >= 0) {
      const marco = marcos.filter(m => f.dias <= m).pop();
      if (marco == null) continue;
      const r = await Core.notificar(app, {
        chave: `requal|${f.id}|${marco}|${String(f.qualificacao_valida_ate).slice(0, 10)}`, tipo: 'REQUALIFICACAO', entidade: 'fornecedor', entidadeId: f.id, fornecedorId: f.id,
        para: cfg.emails_engenharia, assunto: `[Requalificação em ${f.dias} dia(s)] ${nome}`,
        texto: `A qualificação de ${nome} vence em ${fmt(f.qualificacao_valida_ate)} (${f.dias} dia(s)).\n${f.processo_aberto ? 'Há uma requalificação em andamento — conclua até o vencimento.' : 'Inicie a requalificação (FORM 7.3.28) — PRO 7.3.7 item 5.10.1: no mínimo 30 dias antes.'}\nSe não for concluída até o vencimento, a qualificação fica suspensa (item 5.10, Nota 3).`
      });
      if (!r.duplicada) stats.avisosRequalificacao++;
      continue;
    }
    // vencida: suspende até a conclusão da requalificação (Nota 3)
    if (cfg.suspender_requalificacao_vencida && Core.STATUS_ATIVOS.includes(f.status_qualificacao)) {
      const ok = await Core.suspender(app, f, `Requalificação anual não concluída até o vencimento (${fmt(f.qualificacao_valida_ate)}) — PRO 7.3.7 item 5.10, Nota 3.`, null, 'REQUALIFICACAO');
      if (ok) stats.suspensosRequalificacao++;
    }
  }
}

async function rodar(app) {
  const cfg = await Core.config(app.services.Pg);
  const stats = { avisosDocumento: 0, avisosVencidos: 0, suspensos: 0, avisosRequalificacao: 0, suspensosRequalificacao: 0 };
  await rodarDocumentos(app, cfg, stats);
  await rodarRequalificacao(app, cfg, stats);
  return stats;
}

module.exports = { rodar };

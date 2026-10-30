// GET /qualificacao/dashboard — visão de gestão. Perm 23001+.
//
// Monitoramento (classes, alertas, top 10) = só fornecedor CRÍTICO e ATIVO (decisão 30/10/2026:
// não crítico não entra no monitoramento; inativo não aparece). Inspeções do mês e série de
// 12 meses = TODOS os recebimentos (o registro continua para não crítico).
//
// Blocos: fornecedores por classe · alertas (C/D/E e suspensos) · bloqueados aguardando plano
// de ação · C/D sem plano registrado (histórico importado) · requalificação anual (vencida,
// vencendo, sem data) · auditorias de acompanhamento sugeridas (PRO 5.6.2) · documentos ·
// pendências do fluxo · dados do legado.
//
// "Top 10" considera fornecedores com pelo menos 3 inspeções (média de 1 ou 2 entregas não
// diz muito); datas digitadas no futuro ficam fora das séries.

const Q = require('../../services/qfCore');

const MONIT = `ativo AND cardinality(criticidades) > 0`;

module.exports = (app) => ({
  verb: 'get',
  route: '/dashboard',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const regra = await Q.regraAtiva(Pg);
      const cfg = await Q.config(Pg);
      const janelaReq = Math.max(...(cfg.dias_alerta_requalificacao || [60]), 30);
      const [porClasse, contagem, alertas, requal, auditoriasSug, mes, serie, piores, melhores, processos, fichas, auditorias, dadosLegado, itensCriticos, docs] = await Promise.all([
        Pg.connectAndQuery(`SELECT COALESCE(classificacao, '-') classe, COUNT(*)::int n FROM tab_qf_fornecedor WHERE ${MONIT} GROUP BY 1 ORDER BY 1`),
        Pg.connectAndQuery(`SELECT COUNT(*) FILTER (WHERE ${MONIT})::int criticos,
                                   COUNT(*) FILTER (WHERE ativo AND cardinality(criticidades) = 0)::int nao_criticos,
                                   COUNT(*) FILTER (WHERE NOT ativo)::int inativos,
                                   COUNT(*) FILTER (WHERE ${MONIT} AND 'A' = ANY(criticidades))::int crit_a,
                                   COUNT(*) FILTER (WHERE ${MONIT} AND 'B' = ANY(criticidades))::int crit_b,
                                   COUNT(*) FILTER (WHERE ${MONIT} AND 'C' = ANY(criticidades))::int crit_c,
                                   COUNT(*) FILTER (WHERE ${MONIT} AND 'D' = ANY(criticidades))::int crit_d,
                                   COUNT(*) FILTER (WHERE ${MONIT} AND inspecao_100)::int inspecao_100
                              FROM tab_qf_fornecedor`),
        Pg.connectAndQuery(`SELECT id, codigo, razao_social, criticidades, classificacao, iqf_medio, qtd_inspecoes, status_qualificacao, suspensao_tipo,
                                   motivo_suspensao, suspenso_em, plano_acao_iqf IS NOT NULL AS tem_plano, plano_acao_iqf_em, inspecao_100, ultima_inspecao
                              FROM tab_qf_fornecedor
                             WHERE ${MONIT} AND (classificacao IN ('C','D','E') OR status_qualificacao = 'SUSPENSO')
                             ORDER BY status_qualificacao = 'SUSPENSO' DESC, iqf_medio NULLS LAST`),
        Pg.connectAndQuery(`SELECT f.id, f.codigo, f.razao_social, f.criticidades, f.status_qualificacao, f.suspensao_tipo, f.qualificacao_valida_ate,
                                   (f.qualificacao_valida_ate - CURRENT_DATE)::int dias,
                                   (SELECT q.id FROM tab_qf_qualificacao q WHERE q.fornecedor_id = f.id AND q.tipo = 'REQUALIFICACAO' AND q.status IN ('EM_ANDAMENTO','PAUSADO') LIMIT 1) processo_aberto
                              FROM tab_qf_fornecedor f
                             WHERE ${MONIT.replace(/\b(ativo|criticidades)\b/g, 'f.$1')}
                               AND f.status_qualificacao IN ('APROVADO','APROVADO_COM_RESTRICAO','SUSPENSO')
                               AND (f.qualificacao_valida_ate IS NULL OR f.qualificacao_valida_ate <= CURRENT_DATE + @j::int)
                             ORDER BY f.qualificacao_valida_ate NULLS LAST, f.codigo`, { j: janelaReq }),
        Pg.connectAndQuery(`SELECT id, codigo, razao_social, criticidades, classificacao, iqf_medio, auditoria_sugerida_motivo
                              FROM tab_qf_fornecedor WHERE ${MONIT} AND auditoria_sugerida_motivo IS NOT NULL ORDER BY iqf_medio NULLS LAST`),
        Pg.connectAndQuery(`SELECT date_trunc('month', CURRENT_DATE)::date AS mes,
                                   COUNT(*) FILTER (WHERE data_inspecao >= date_trunc('month', CURRENT_DATE))::int qtd,
                                   COUNT(*) FILTER (WHERE data_inspecao >= date_trunc('month', CURRENT_DATE) AND nc)::int ncs,
                                   AVG(iqf) FILTER (WHERE data_inspecao >= date_trunc('month', CURRENT_DATE)) iqf,
                                   COUNT(*) FILTER (WHERE data_inspecao >= date_trunc('month', CURRENT_DATE) AND item_criticidade IS NOT NULL)::int itens_criticos,
                                   COUNT(*) FILTER (WHERE data_inspecao >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month' AND data_inspecao < date_trunc('month', CURRENT_DATE))::int qtd_ant,
                                   COUNT(*) FILTER (WHERE data_inspecao >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month' AND data_inspecao < date_trunc('month', CURRENT_DATE) AND nc)::int ncs_ant,
                                   AVG(iqf) FILTER (WHERE data_inspecao >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month' AND data_inspecao < date_trunc('month', CURRENT_DATE)) iqf_ant
                              FROM tab_qf_inspecao WHERE NOT excluido AND data_inspecao <= CURRENT_DATE`),
        Pg.connectAndQuery(`SELECT to_char(date_trunc('month', data_inspecao), 'YYYY-MM') mes, COUNT(*)::int qtd, COUNT(*) FILTER (WHERE nc)::int ncs,
                                   AVG(iqf) iqf, COUNT(DISTINCT fornecedor_id)::int fornecedores
                              FROM tab_qf_inspecao
                             WHERE NOT excluido AND data_inspecao > date_trunc('month', CURRENT_DATE) - INTERVAL '12 months' AND data_inspecao <= CURRENT_DATE
                             GROUP BY 1 ORDER BY 1`),
        Pg.connectAndQuery(`SELECT id, codigo, razao_social, criticidades, iqf_medio, qtd_inspecoes, classificacao, status_qualificacao
                              FROM tab_qf_fornecedor WHERE ${MONIT} AND qtd_inspecoes >= 3 ORDER BY iqf_medio ASC, qtd_inspecoes DESC LIMIT 10`),
        Pg.connectAndQuery(`SELECT id, codigo, razao_social, criticidades, iqf_medio, qtd_inspecoes, classificacao, status_qualificacao
                              FROM tab_qf_fornecedor WHERE ${MONIT} AND qtd_inspecoes >= 3 ORDER BY iqf_medio DESC, qtd_inspecoes DESC LIMIT 10`),
        Pg.connectAndQuery(`SELECT q.id, q.fornecedor_id, f.codigo, f.razao_social, q.tipo, q.etapa, q.status, q.iniciado_em
                              FROM tab_qf_qualificacao q JOIN tab_qf_fornecedor f ON f.id = q.fornecedor_id
                             WHERE q.status IN ('EM_ANDAMENTO','PAUSADO') ORDER BY q.iniciado_em`),
        Pg.connectAndQuery(`SELECT fi.id, fi.fornecedor_id, f.codigo, f.razao_social, fi.formulario, fi.status, fi.respondida_em, fi.enviada_em, fi.token_expira_em
                              FROM tab_qf_ficha fi JOIN tab_qf_fornecedor f ON f.id = fi.fornecedor_id
                             WHERE fi.status IN ('RESPONDIDA','ENVIADA','DEVOLVIDA') ORDER BY fi.status = 'RESPONDIDA' DESC, fi.respondida_em`),
        Pg.connectAndQuery(`SELECT a.id, a.fornecedor_id, f.codigo, f.razao_social, a.tipo, a.motivo_tipo, a.data_agendada
                              FROM tab_qf_auditoria a JOIN tab_qf_fornecedor f ON f.id = a.fornecedor_id
                             WHERE a.status = 'AGENDADA' ORDER BY a.data_agendada`),
        Pg.connectAndQuery(`SELECT COUNT(*) FILTER (WHERE data_inspecao > CURRENT_DATE)::int datas_futuras,
                                   COUNT(*) FILTER (WHERE data_inspecao IS NULL)::int sem_data,
                                   COUNT(*) FILTER (WHERE legado_avisos IS NOT NULL)::int com_aviso
                              FROM tab_qf_inspecao WHERE NOT excluido`),
        Pg.connectAndQuery(`SELECT COUNT(*)::int n FROM tab_qf_item_critico WHERE ativo`),
        Q.situacaoDocsCriticos(Pg)
      ]);

      // documentos: resumo por janela
      const linhasDoc = [];
      for (const s of docs.values()) for (const i of s.itens) linhasDoc.push({ f: s.fornecedor, i });
      const vencendo = (d) => linhasDoc.filter(x => x.i.venceEm != null && x.i.venceEm <= d && ['OK', 'VENCENDO', 'PROTOCOLADO'].includes(x.i.situacao)).length;
      const vencidos = linhasDoc.filter(x => ['VENCIDO', 'PROTOCOLO_VENCIDO'].includes(x.i.situacao));
      const m = mes[0];
      const pct = (q, n) => (q ? Math.round((1 - n / q) * 1000) / 10 : null);
      const r4 = (v) => (v == null ? null : Q.r4(v));
      const aguardandoPlano = alertas.filter(a => a.status_qualificacao === 'SUSPENSO' && Q.TIPOS_PLANO.includes(a.suspensao_tipo));
      const cdSemPlano = alertas.filter(a => ['C', 'D'].includes(a.classificacao) && !a.tem_plano && a.status_qualificacao !== 'SUSPENSO');
      const c = contagem[0];

      return res.json({
        regra: { id: regra.id, nome: regra.nome, classes: regra.conteudo.classes },
        porClasse,
        contagem: {
          criticos: c.criticos, naoCriticos: c.nao_criticos, inativos: c.inativos, inspecao100: c.inspecao_100,
          porCriticidade: { A: c.crit_a, B: c.crit_b, C: c.crit_c, D: c.crit_d }, itensCriticos: itensCriticos[0].n
        },
        alertas,
        aguardandoPlano,
        cdSemPlano,
        requalificacao: {
          janelaDias: janelaReq,
          vencidas: requal.filter(r => r.dias != null && r.dias < 0),
          vencendo: requal.filter(r => r.dias != null && r.dias >= 0),
          semData: requal.filter(r => r.dias == null)
        },
        auditoriasSugeridas: auditoriasSug,
        documentos: {
          vencidos: vencidos.length, em30: vencendo(30), em60: vencendo(60), em90: vencendo(90),
          pendentes: linhasDoc.filter(x => x.i.situacao === 'PENDENTE' && x.i.regra === 'OBRIGATORIO').length,
          protocolados: linhasDoc.filter(x => x.i.situacao === 'PROTOCOLADO').length,
          fornecedoresComPendencia: [...docs.values()].filter(s => !s.completo || s.vencidos > 0).length,
          criticos: docs.size,
          listaVencidos: vencidos.slice(0, 20).map(x => ({ fornecedorId: x.f.id, codigo: x.f.codigo, razaoSocial: x.f.razao_social, documento: x.i.nome,
            situacao: x.i.situacao, validade: x.i.documento && (x.i.situacao === 'PROTOCOLO_VENCIDO' ? x.i.documento.prazo_regularizacao : x.i.documento.data_validade) }))
        },
        mes: {
          referencia: m.mes, inspecoes: m.qtd, comNc: m.ncs, pctConforme: pct(m.qtd, m.ncs), iqfMedio: r4(m.iqf), itensCriticos: m.itens_criticos,
          anterior: { inspecoes: m.qtd_ant, comNc: m.ncs_ant, pctConforme: pct(m.qtd_ant, m.ncs_ant), iqfMedio: r4(m.iqf_ant) }
        },
        serie: serie.map(s => ({ ...s, iqf: r4(s.iqf), pctConforme: pct(s.qtd, s.ncs) })),
        piores, melhores,
        fluxo: { processos, fichas, auditorias },
        dadosLegado: dadosLegado[0]
      });
    } catch (err) { return Q.falha(res, 'montar o dashboard', err); }
  }
});

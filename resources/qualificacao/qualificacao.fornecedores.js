// GET /qualificacao/fornecedores — FORM 7.3.24 Lista de Qualificação de Fornecedores
// (Monitoramento).
//
// Filtros: q (código, razão, fantasia, CNPJ) · criticidade (CSV: CRITICOS | NAO | A | B | C | D —
// fornecedor com QUALQUER das letras) · status (CSV) · classificacao (CSV de A–E; SEM) · tipo ·
// pendenciaDoc=1 · requalificacao (VENCIDA | VENCENDO | SEM_DATA) · bloqueio=PLANO ·
// auditoria=1 (gatilho do PRO 5.6.2) · ativo (1/0/todos) · aptos=1 (autocomplete do recebimento:
// ativo e APROVADO/APROVADO_COM_RESTRICAO). Paginação no servidor (pageSize ≤ 200).

const Q = require('../../services/qfCore');

const ORDENS = {
  codigo: 'f.codigo', razao: 'f.razao_social', iqf: 'f.iqf_medio', classe: 'f.classificacao',
  qtd: 'f.qtd_inspecoes', ultima: 'f.ultima_inspecao', status: 'f.status_qualificacao', validade: 'f.qualificacao_valida_ate'
};
const csv = (v) => String(v || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

module.exports = (app) => ({
  verb: 'get',
  route: '/fornecedores',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const qs = req.query;
    const page = Math.max(1, Number(qs.page) || 1);
    const pageSize = Math.min(200, Math.max(5, Number(qs.pageSize) || 50));
    const cond = ['TRUE'];
    const p = {};

    try {
      const docs = await Q.situacaoDocsCriticos(Pg);

      const busca = Q.trim(qs.q);
      if (busca) {
        cond.push(`(f.codigo = @cod OR f.razao_social ILIKE @like OR f.nome_fantasia ILIKE @like OR (LENGTH(@doc) >= 4 AND REGEXP_REPLACE(COALESCE(f.cnpj,''), '\\D', '', 'g') LIKE @docLike))`);
        p.cod = /^\d{1,6}$/.test(busca) ? busca.padStart(6, '0') : busca.toUpperCase();
        p.like = `%${busca}%`;
        p.doc = busca.replace(/\D/g, '');
        p.docLike = `%${p.doc}%`;
      }
      const crit = csv(qs.criticidade);
      if (crit.includes('CRITICOS')) cond.push('cardinality(f.criticidades) > 0');
      else if (crit.includes('NAO')) cond.push('cardinality(f.criticidades) = 0');
      else if (crit.length) { cond.push('f.criticidades && @crit::varchar[]'); p.crit = crit.filter(c => /^[ABCD]$/.test(c)); }
      const st = csv(qs.status);
      if (Q.trim(qs.aptos) === '1') cond.push(`f.ativo AND f.status_qualificacao IN ('APROVADO','APROVADO_COM_RESTRICAO')`);
      else if (st.length) { cond.push('f.status_qualificacao = ANY(@st)'); p.st = st; }
      const cls = csv(qs.classificacao);
      if (cls.length) {
        const letras = cls.filter(c => /^[A-E]$/.test(c));
        cond.push(`(${[letras.length ? 'f.classificacao = ANY(@cls)' : null, cls.includes('SEM') ? 'f.classificacao IS NULL' : null].filter(Boolean).join(' OR ') || 'FALSE'})`);
        p.cls = letras;
      }
      if (Q.trim(qs.tipo)) { cond.push('f.tipo_fornecimento = @tipo'); p.tipo = Q.trim(qs.tipo); }
      const ativo = Q.trim(qs.ativo);
      if (ativo === '0') cond.push('NOT f.ativo'); else if (ativo !== 'todos' && Q.trim(qs.aptos) !== '1') cond.push('f.ativo');
      if (Q.trim(qs.pendenciaDoc) === '1') {
        p.pend = [...docs.values()].filter(x => !x.completo || x.vencidos > 0).map(x => x.fornecedor.id);
        cond.push('f.id = ANY(@pend)');
      }
      const rq = Q.trim(qs.requalificacao).toUpperCase();
      if (rq === 'VENCIDA') cond.push(`cardinality(f.criticidades) > 0 AND f.qualificacao_valida_ate < CURRENT_DATE`);
      if (rq === 'VENCENDO') cond.push(`cardinality(f.criticidades) > 0 AND f.qualificacao_valida_ate BETWEEN CURRENT_DATE AND CURRENT_DATE + 60`);
      if (rq === 'SEM_DATA') cond.push(`cardinality(f.criticidades) > 0 AND f.qualificacao_valida_ate IS NULL AND f.status_qualificacao IN ('APROVADO','APROVADO_COM_RESTRICAO')`);
      if (Q.trim(qs.bloqueio).toUpperCase() === 'PLANO') cond.push(`f.status_qualificacao = 'SUSPENSO' AND f.suspensao_tipo IN ('PLANO_ACAO_C','PLANO_ACAO_D')`);
      if (Q.trim(qs.auditoria) === '1') cond.push('f.auditoria_sugerida_motivo IS NOT NULL');
      if (Q.trim(qs.comInspecao) === '1') cond.push('f.qtd_inspecoes > 0');

      const ordem = ORDENS[qs.ordem] || 'f.codigo';
      const dir = Q.trim(qs.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      const where = cond.join(' AND ');

      const [tot] = await Pg.connectAndQuery(`SELECT COUNT(*)::int n FROM tab_qf_fornecedor f WHERE ${where}`, p);
      const linhas = await Pg.connectAndQuery(
        `SELECT f.id, f.codigo, f.razao_social, f.nome_fantasia, f.cnpj, f.estado, f.nacional, f.criticidades, f.tipo_fornecimento,
                f.status_qualificacao, f.suspensao_tipo, f.motivo_suspensao, f.sgq_bpf, f.sgq_iso13485, f.sgq_iso9001, f.sgq_acordo,
                f.sgq_questionario, f.nota_sgq, f.iqf_medio, f.qtd_inspecoes, f.classificacao, f.ultima_inspecao, f.ativo, f.legado,
                f.inspecao_100, f.qualificacao_valida_ate, f.auditoria_sugerida_motivo, f.plano_acao_iqf IS NOT NULL AS tem_plano,
                (f.qualificacao_valida_ate - CURRENT_DATE)::int AS dias_validade,
                COALESCE(array_length(f.pendencias, 1), 0) AS qtd_pendencias,
                q.id AS processo_id, q.tipo AS processo_tipo, q.etapa AS processo_etapa, q.status AS processo_status
           FROM tab_qf_fornecedor f
           LEFT JOIN LATERAL (SELECT id, tipo, etapa, status FROM tab_qf_qualificacao
                               WHERE fornecedor_id = f.id AND status IN ('EM_ANDAMENTO','PAUSADO') ORDER BY id DESC LIMIT 1) q ON TRUE
          WHERE ${where}
          ORDER BY ${ordem} ${dir} NULLS LAST, f.codigo
          LIMIT @lim OFFSET @off`, { ...p, lim: pageSize, off: (page - 1) * pageSize });

      const [c] = await Pg.connectAndQuery(
        `SELECT COUNT(*) FILTER (WHERE cardinality(criticidades) > 0)::int criticos,
                COUNT(*) FILTER (WHERE cardinality(criticidades) = 0)::int nao_criticos,
                COUNT(*) FILTER (WHERE 'A' = ANY(criticidades))::int a, COUNT(*) FILTER (WHERE 'B' = ANY(criticidades))::int b,
                COUNT(*) FILTER (WHERE 'C' = ANY(criticidades))::int c, COUNT(*) FILTER (WHERE 'D' = ANY(criticidades))::int d,
                COUNT(*) FILTER (WHERE status_qualificacao = 'SUSPENSO' AND suspensao_tipo IN ('PLANO_ACAO_C','PLANO_ACAO_D'))::int bloqueio_plano,
                COUNT(*) FILTER (WHERE cardinality(criticidades) > 0 AND qualificacao_valida_ate < CURRENT_DATE)::int requal_vencida,
                COUNT(*) FILTER (WHERE cardinality(criticidades) > 0 AND qualificacao_valida_ate BETWEEN CURRENT_DATE AND CURRENT_DATE + 60)::int requal_vencendo,
                COUNT(*) FILTER (WHERE cardinality(criticidades) > 0 AND qualificacao_valida_ate IS NULL AND status_qualificacao IN ('APROVADO','APROVADO_COM_RESTRICAO'))::int requal_sem_data,
                COUNT(*) FILTER (WHERE auditoria_sugerida_motivo IS NOT NULL)::int auditoria
           FROM tab_qf_fornecedor WHERE ativo`);
      const classes = await Pg.connectAndQuery(
        `SELECT COALESCE(classificacao, '-') classe, COUNT(*)::int n FROM tab_qf_fornecedor WHERE ativo AND cardinality(criticidades) > 0 GROUP BY 1`);
      const status = await Pg.connectAndQuery(`SELECT status_qualificacao s, COUNT(*)::int n FROM tab_qf_fornecedor WHERE ativo GROUP BY 1`);

      return res.json({
        total: tot.n, page, pageSize,
        linhas: linhas.map(l => {
          const d = docs.get(l.id);
          return { ...l, docs: d ? { completo: d.completo, pendentes: d.pendentes, vencidos: d.vencidos, vencendo: d.vencendo, protocolados: d.protocolados } : null };
        }),
        contagens: {
          porClasse: Object.fromEntries(classes.map(x => [x.classe, x.n])),
          porStatus: Object.fromEntries(status.map(x => [x.s, x.n])),
          porCriticidade: { CRITICOS: c.criticos, NAO: c.nao_criticos, A: c.a, B: c.b, C: c.c, D: c.d },
          bloqueioPlano: c.bloqueio_plano, requalVencida: c.requal_vencida, requalVencendo: c.requal_vencendo, requalSemData: c.requal_sem_data,
          auditoria: c.auditoria,
          pendenciaDoc: [...docs.values()].filter(x => !x.completo || x.vencidos > 0).length
        }
      });
    } catch (err) { return Q.falha(res, 'listar os fornecedores', err); }
  }
});

// GET /universidade/rh/painel — visão geral da conformidade de treinamentos.
// KPIs, por departamento, admissões/mudanças de cargo recentes, cargos sem trilha e
// última sincronização com o Protheus. Perm 15004/15005/15003.

const { LER, requirePerm, camel, situacaoGeral } = require('./_rh');

module.exports = (app) => ({
  verb: 'get',
  route: '/rh/painel',
  middlewares: [requirePerm(app, LER)],

  handler: async (req, res) => {
    const { Pg } = app.services;

    const [porSituacao, porPessoa, porDepto, recentes, semTrilha, sync, totais] = await Promise.all([
      Pg.connectAndQuery(`
        SELECT s.situacao, count(*)::int AS n
          FROM vw_uni_requisito_situacao s
          JOIN tab_uni_colaborador c ON c.id = s.colaborador_id AND c.ativo
         WHERE s.ativo AND s.obrigatorio
         GROUP BY s.situacao`),
      Pg.connectAndQuery(`
        SELECT c.id,
               count(s.id)::int AS total,
               count(*) FILTER (WHERE s.situacao = 'pendente')::int      AS pendente,
               count(*) FILTER (WHERE s.situacao = 'atrasado')::int      AS atrasado,
               count(*) FILTER (WHERE s.situacao = 'vencido')::int       AS vencido,
               count(*) FILTER (WHERE s.situacao = 'desatualizado')::int AS desatualizado
          FROM tab_uni_colaborador c
          LEFT JOIN vw_uni_requisito_situacao s ON s.colaborador_id = c.id AND s.ativo AND s.obrigatorio
         WHERE c.ativo
         GROUP BY c.id`),
      Pg.connectAndQuery(`
        SELECT COALESCE(NULLIF(c.depto_desc, ''), '(sem departamento)') AS depto,
               count(DISTINCT c.id)::int AS pessoas,
               count(s.id)::int AS requisitos,
               count(*) FILTER (WHERE s.situacao IN ('em_dia','a_vencer','dispensado'))::int AS conformes,
               count(*) FILTER (WHERE s.situacao = 'pendente')::int AS pendentes,
               count(*) FILTER (WHERE s.situacao IN ('atrasado','vencido','desatualizado'))::int AS irregulares
          FROM tab_uni_colaborador c
          LEFT JOIN vw_uni_requisito_situacao s ON s.colaborador_id = c.id AND s.ativo AND s.obrigatorio
         WHERE c.ativo
         GROUP BY 1
         ORDER BY irregulares DESC, pendentes DESC, depto`),
      Pg.connectAndQuery(`
        SELECT e.id, e.tipo, e.de, e.para, e.data::text AS data, c.id AS colaborador_id, c.nome, c.matricula,
               c.depto_desc, c.cargo_desc,
               (SELECT count(*) FROM vw_uni_requisito_situacao s
                 WHERE s.colaborador_id = c.id AND s.ativo AND s.obrigatorio)::int AS requisitos,
               (SELECT count(*) FROM vw_uni_requisito_situacao s
                 WHERE s.colaborador_id = c.id AND s.ativo AND s.obrigatorio
                   AND s.situacao IN ('em_dia','a_vencer','dispensado'))::int AS conformes
          FROM tab_uni_colaborador_evento e
          JOIN tab_uni_colaborador c ON c.id = e.colaborador_id
         WHERE e.tipo IN ('admissao','mudanca_cargo','mudanca_setor','readmissao')
           AND e.registrado_em >= NOW() - INTERVAL '60 days'
         ORDER BY e.data DESC NULLS LAST, e.id DESC
         LIMIT 50`),
      // cargo × setor com gente e sem nenhuma trilha específica (só as "para todos")
      Pg.connectAndQuery(`
        SELECT c.cargo_codigo, MAX(c.cargo_desc) AS cargo_desc, c.depto_codigo, MAX(c.depto_desc) AS depto_desc,
               count(*)::int AS pessoas
          FROM tab_uni_colaborador c
         WHERE c.ativo
           AND NOT EXISTS (SELECT 1 FROM vw_uni_colaborador_trilha ct
                            WHERE ct.colaborador_id = c.id AND ct.via <> 'todos')
         GROUP BY c.cargo_codigo, c.depto_codigo
         ORDER BY pessoas DESC, cargo_desc, depto_desc`),
      Pg.connectAndQuery(`
        SELECT id, iniciado_em, concluido_em, ok, origem, resumo, erro
          FROM tab_uni_sync_log ORDER BY id DESC LIMIT 1`),
      Pg.connectAndQuery(`
        SELECT (SELECT count(*) FROM tab_uni_trilha WHERE ativo)::int AS trilhas,
               (SELECT count(*) FROM tab_uni_curso WHERE ativo)::int AS cursos,
               (SELECT count(*) FROM tab_uni_trilha_item ti JOIN tab_uni_trilha t ON t.id = ti.trilha_id AND t.ativo)::int AS itens,
               (SELECT count(*) FROM tab_uni_trilha WHERE ativo AND aplica_todos)::int AS trilhas_todos`)
    ]);

    const sit = {};
    porSituacao.forEach(r => { sit[r.situacao] = r.n; });
    const totalReq = porSituacao.reduce((a, r) => a + r.n, 0);
    const conformes = (sit.em_dia || 0) + (sit.a_vencer || 0) + (sit.dispensado || 0);

    const pessoas = { total: porPessoa.length, em_dia: 0, pendente: 0, irregular: 0, sem_trilha: 0 };
    porPessoa.forEach(p => { pessoas[situacaoGeral(p)]++; });

    return res.json({
      kpis: {
        colaboradores: pessoas.total,
        pessoasEmDia: pessoas.em_dia,
        pessoasPendentes: pessoas.pendente,
        pessoasIrregulares: pessoas.irregular,
        pessoasSemTrilha: pessoas.sem_trilha,
        requisitos: totalReq,
        requisitosConformes: conformes,
        percentualConformidade: totalReq ? Math.round((conformes / totalReq) * 1000) / 10 : null,
        porSituacao: sit,
        ...camel(totais[0] || {})
      },
      porDepartamento: porDepto.map(camel),
      movimentacoes: recentes.map(camel),
      perfisSemTrilha: semTrilha.map(camel),
      ultimaSincronizacao: sync[0] ? camel(sync[0]) : null
    });
  }
});

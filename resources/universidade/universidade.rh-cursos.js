// GET /universidade/rh/cursos — catálogo de cursos com versões (plano de ensino),
// trilhas em que aparecem, turmas do Treinamentos vinculadas e quantos requisitos
// dependem de cada um. Também devolve áreas, categorias e turmas p/ vincular.
// Perm 15004/15005/15003.

const { LER, requirePerm, camel } = require('./_rh');

module.exports = (app) => ({
  verb: 'get',
  route: '/rh/cursos',
  middlewares: [requirePerm(app, LER)],

  handler: async (req, res) => {
    const { Pg } = app.services;

    const [cursos, versoes, trilhas, turmas, areas, categorias] = await Promise.all([
      Pg.connectAndQuery(`
        SELECT cu.id, cu.codigo, cu.titulo, cu.descricao, cu.categoria_id, cat.nome AS categoria,
               cu.area_id, a.codigo AS area, a.nome AS area_nome, cu.formato, cu.validade_meses,
               cu.setor_responsavel, cu.carga_horaria_h, cu.ativo, cu.publico, cu.instrutor_nome,
               cu.versao_atual_id, cu.criado_em,
               (SELECT count(*) FROM tab_uni_aula au WHERE au.curso_id = cu.id)::int AS qtd_aulas,
               EXISTS (SELECT 1 FROM tab_uni_quiz q WHERE q.curso_id = cu.id AND q.ativo) AS tem_quiz,
               (SELECT count(*) FROM tab_uni_requisito r
                  JOIN tab_uni_colaborador c ON c.id = r.colaborador_id AND c.ativo
                 WHERE r.curso_id = cu.id AND r.ativo)::int AS requisitos,
               (SELECT count(*) FROM vw_uni_requisito_situacao s
                  JOIN tab_uni_colaborador c ON c.id = s.colaborador_id AND c.ativo
                 WHERE s.curso_id = cu.id AND s.ativo AND s.situacao = 'desatualizado')::int AS desatualizados
          FROM tab_uni_curso cu
          LEFT JOIN tab_uni_area a        ON a.id = cu.area_id
          LEFT JOIN tab_uni_categoria cat ON cat.id = cu.categoria_id
         ORDER BY cu.ativo DESC, cu.titulo`),
      Pg.connectAndQuery(`
        SELECT v.id, v.curso_id, v.revisao, v.tipo, v.status, v.vigente_desde::text AS vigente_desde,
               v.exige_retreinamento, v.resumo_mudanca, v.objetivos, v.conteudo, v.materiais, v.observacoes,
               v.duracao_min, v.capacidade, v.professores, v.documento_url,
               v.publicado_em, up.nome AS publicado_por, v.criado_em, uc.nome AS criado_por
          FROM tab_uni_curso_versao v
          LEFT JOIN tab_intranet_usr up ON up.id = v.publicado_por
          LEFT JOIN tab_intranet_usr uc ON uc.id = v.criado_por
         ORDER BY v.curso_id, COALESCE(v.vigente_desde, '9999-12-31'::date) DESC, v.id DESC`),
      Pg.connectAndQuery(`
        SELECT ti.curso_id, t.id, t.codigo, t.nome, ti.codigo_exibicao, ti.obrigatorio
          FROM tab_uni_trilha_item ti JOIN tab_uni_trilha t ON t.id = ti.trilha_id
         ORDER BY t.codigo`),
      Pg.connectAndQuery(`
        SELECT t.id, t.titulo, t.status, t.curso_id, t.curso_versao_id, t.modalidades,
               (SELECT min(s.data) FROM tab_treina_sessao s WHERE s.treinamento_id = t.id AND s.status = 'agendada')::text AS primeira_data,
               (SELECT max(s.data) FROM tab_treina_sessao s WHERE s.treinamento_id = t.id AND s.status = 'agendada')::text AS ultima_data,
               (SELECT count(*) FROM tab_treina_inscricao i WHERE i.treinamento_id = t.id AND i.status = 'ativa' AND i.presente)::int AS presentes
          FROM tab_treina_treinamento t
         WHERE t.status <> 'cancelado' OR t.curso_id IS NOT NULL
         ORDER BY t.criado_em DESC`),
      Pg.connectAndQuery(`SELECT id, codigo, nome, ativo FROM tab_uni_area ORDER BY ativo DESC, codigo`),
      Pg.connectAndQuery(`SELECT id, nome, cor FROM tab_uni_categoria WHERE ativo ORDER BY ordem, nome`)
    ]);

    const lista = cursos.map(c => ({
      ...camel(c),
      versoes: versoes.filter(v => v.curso_id === c.id).map(camel),
      trilhas: trilhas.filter(t => t.curso_id === c.id).map(camel),
      turmas: turmas.filter(t => t.curso_id === c.id).map(camel)
    }));

    return res.json({
      cursos: lista,
      areas: areas.map(camel),
      categorias: categorias.map(camel),
      turmas: turmas.map(camel)
    });
  }
});

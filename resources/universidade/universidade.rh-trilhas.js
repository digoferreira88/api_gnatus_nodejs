// GET /universidade/rh/trilhas — trilhas (com cursos e cargos vinculados), cargos do
// Protheus (os que têm gente primeiro) e a lista de cursos p/ montar trilha.
// Perm 15004/15005/15003.

const { LER, requirePerm, camel } = require('./_rh');

module.exports = (app) => ({
  verb: 'get',
  route: '/rh/trilhas',
  middlewares: [requirePerm(app, LER)],

  handler: async (req, res) => {
    const { Pg } = app.services;

    const [trilhas, itens, links, cargos, cursos, pessoasTrilha] = await Promise.all([
      Pg.connectAndQuery(`
        SELECT id, codigo, nome, descricao, publico, aplica_todos, ativo, criado_em, atualizado_em
          FROM tab_uni_trilha ORDER BY ativo DESC, aplica_todos DESC, codigo`),
      Pg.connectAndQuery(`
        SELECT ti.id, ti.trilha_id, ti.curso_id, ti.ordem, ti.obrigatorio, ti.prazo_dias, ti.codigo_exibicao,
               cu.codigo AS curso_codigo, cu.titulo AS curso_titulo, cu.formato, cu.ativo AS curso_ativo,
               cu.validade_meses, cu.carga_horaria_h
          FROM tab_uni_trilha_item ti
          JOIN tab_uni_curso cu ON cu.id = ti.curso_id
         ORDER BY ti.trilha_id, ti.ordem, cu.titulo`),
      Pg.connectAndQuery(`SELECT cargo_codigo, trilha_id FROM tab_uni_cargo_trilha`),
      Pg.connectAndQuery(`
        SELECT g.codigo, g.descricao, g.ativo,
               (SELECT count(*) FROM tab_uni_colaborador c WHERE c.ativo AND c.cargo_codigo = g.codigo)::int AS pessoas,
               (SELECT string_agg(DISTINCT c.depto_desc, ', ') FROM tab_uni_colaborador c
                 WHERE c.ativo AND c.cargo_codigo = g.codigo) AS departamentos
          FROM tab_uni_cargo g
         ORDER BY (SELECT count(*) FROM tab_uni_colaborador c WHERE c.ativo AND c.cargo_codigo = g.codigo) DESC,
                  g.descricao`),
      Pg.connectAndQuery(`
        SELECT cu.id, cu.codigo, cu.titulo, cu.formato, cu.ativo, cu.validade_meses, a.codigo AS area
          FROM tab_uni_curso cu LEFT JOIN tab_uni_area a ON a.id = cu.area_id
         ORDER BY cu.ativo DESC, cu.titulo`),
      Pg.connectAndQuery(`
        SELECT t.id AS trilha_id, count(DISTINCT c.id)::int AS pessoas
          FROM tab_uni_trilha t
          JOIN tab_uni_colaborador c ON c.ativo
          LEFT JOIN tab_uni_cargo_trilha ct ON ct.trilha_id = t.id AND ct.cargo_codigo = c.cargo_codigo
         WHERE t.aplica_todos OR ct.trilha_id IS NOT NULL
         GROUP BY t.id`)
    ]);

    const pessoasPor = new Map(pessoasTrilha.map(p => [p.trilha_id, p.pessoas]));
    const lista = trilhas.map(t => ({
      ...camel(t),
      pessoas: pessoasPor.get(t.id) || 0,
      itens: itens.filter(i => i.trilha_id === t.id).map(camel),
      cargos: links.filter(l => l.trilha_id === t.id).map(l => l.cargo_codigo)
    }));

    const cargosLista = cargos.map(g => ({
      ...camel(g),
      trilhaIds: links.filter(l => l.cargo_codigo === g.codigo).map(l => l.trilha_id)
    }));

    return res.json({ trilhas: lista, cargos: cargosLista, cursos: cursos.map(camel) });
  }
});

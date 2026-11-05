// GET /universidade/rh/trilhas — trilhas (cursos + regras de quem recebe), cargos e
// setores do Protheus, as combinações cargo × setor que têm gente (com as trilhas que
// cada uma recebe) e a lista de cursos p/ montar trilha. Perm 15004/15005/15003.
//
// Regra = (cargo opcional, setor opcional): cargo em qualquer setor · cargo só num
// setor · setor inteiro. Ver migration 141.

const { LER, requirePerm, camel } = require('./_rh');

module.exports = (app) => ({
  verb: 'get',
  route: '/rh/trilhas',
  middlewares: [requirePerm(app, LER)],

  handler: async (req, res) => {
    const { Pg } = app.services;

    const [trilhas, itens, regras, cargos, departamentos, cursos, pessoasTrilha, perfis, aplicadas] = await Promise.all([
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
      Pg.connectAndQuery(`
        SELECT r.id, r.trilha_id, r.cargo_codigo, g.descricao AS cargo_desc, r.depto_codigo, d.descricao AS depto_desc,
               (SELECT count(*) FROM tab_uni_colaborador c
                 WHERE c.ativo AND (r.cargo_codigo IS NULL OR c.cargo_codigo = r.cargo_codigo)
                   AND (r.depto_codigo IS NULL OR c.depto_codigo = r.depto_codigo))::int AS pessoas,
               r.criado_em
          FROM tab_uni_trilha_regra r
          LEFT JOIN tab_uni_cargo g        ON g.codigo = r.cargo_codigo
          LEFT JOIN tab_uni_departamento d ON d.codigo = r.depto_codigo
         ORDER BY r.trilha_id, g.descricao NULLS LAST, d.descricao NULLS FIRST`),
      Pg.connectAndQuery(`
        SELECT g.codigo, g.descricao, g.ativo,
               (SELECT count(*) FROM tab_uni_colaborador c WHERE c.ativo AND c.cargo_codigo = g.codigo)::int AS pessoas,
               (SELECT string_agg(DISTINCT c.depto_desc, ', ') FROM tab_uni_colaborador c
                 WHERE c.ativo AND c.cargo_codigo = g.codigo) AS departamentos
          FROM tab_uni_cargo g
         ORDER BY (SELECT count(*) FROM tab_uni_colaborador c WHERE c.ativo AND c.cargo_codigo = g.codigo) DESC,
                  g.descricao`),
      Pg.connectAndQuery(`
        SELECT d.codigo, d.descricao, d.ativo,
               (SELECT count(*) FROM tab_uni_colaborador c WHERE c.ativo AND c.depto_codigo = d.codigo)::int AS pessoas
          FROM tab_uni_departamento d
         ORDER BY (SELECT count(*) FROM tab_uni_colaborador c WHERE c.ativo AND c.depto_codigo = d.codigo) DESC,
                  d.descricao`),
      Pg.connectAndQuery(`
        SELECT cu.id, cu.codigo, cu.titulo, cu.formato, cu.ativo, cu.validade_meses, a.codigo AS area
          FROM tab_uni_curso cu LEFT JOIN tab_uni_area a ON a.id = cu.area_id
         ORDER BY cu.ativo DESC, cu.titulo`),
      Pg.connectAndQuery(`
        SELECT trilha_id, count(DISTINCT colaborador_id)::int AS pessoas
          FROM vw_uni_colaborador_trilha GROUP BY trilha_id`),
      // combinações cargo × setor com gente ativa (todas as pessoas de um par recebem as mesmas trilhas)
      Pg.connectAndQuery(`
        SELECT c.cargo_codigo, MAX(c.cargo_desc) AS cargo_desc, c.depto_codigo, MAX(c.depto_desc) AS depto_desc,
               count(*)::int AS pessoas, MIN(c.id) AS um_colaborador
          FROM tab_uni_colaborador c
         WHERE c.ativo
         GROUP BY c.cargo_codigo, c.depto_codigo
         ORDER BY MAX(c.cargo_desc), MAX(c.depto_desc)`),
      Pg.connectAndQuery(`SELECT colaborador_id, trilha_id, via FROM vw_uni_colaborador_trilha`)
    ]);

    const pessoasPor = new Map(pessoasTrilha.map(p => [p.trilha_id, p.pessoas]));
    const lista = trilhas.map(t => ({
      ...camel(t),
      pessoas: pessoasPor.get(t.id) || 0,
      itens: itens.filter(i => i.trilha_id === t.id).map(camel),
      regras: regras.filter(r => r.trilha_id === t.id).map(camel),
      // compatibilidade: cargos com regra "em qualquer setor"
      cargos: regras.filter(r => r.trilha_id === t.id && r.cargo_codigo && !r.depto_codigo).map(r => r.cargo_codigo)
    }));

    // 1 entrada por trilha; se vier por mais de uma regra, fica a mais específica
    const PESO = { cargo_setor: 4, cargo: 3, setor: 2, todos: 1 };
    const porColab = new Map();
    aplicadas.forEach(a => {
      if (!porColab.has(a.colaborador_id)) porColab.set(a.colaborador_id, new Map());
      const m = porColab.get(a.colaborador_id);
      const atual = m.get(a.trilha_id);
      if (!atual || PESO[a.via] > PESO[atual]) m.set(a.trilha_id, a.via);
    });
    const aplicadasDe = (id) => [...(porColab.get(id) || new Map()).entries()].map(([trilhaId, via]) => ({ trilhaId, via }));

    const cargosLista = cargos.map(g => ({
      ...camel(g),
      trilhaIds: regras.filter(r => r.cargo_codigo === g.codigo && !r.depto_codigo).map(r => r.trilha_id)
    }));

    return res.json({
      trilhas: lista,
      cargos: cargosLista,
      departamentos: departamentos.map(camel),
      perfis: perfis.map(p => ({
        cargoCodigo: p.cargo_codigo, cargoDesc: p.cargo_desc, deptoCodigo: p.depto_codigo, deptoDesc: p.depto_desc,
        pessoas: p.pessoas, aplicadas: aplicadasDe(p.um_colaborador)
      })),
      cursos: cursos.map(camel)
    });
  }
});

// GET /universidade/rh/matriz?depto=&cargo=&trilha=
// Matriz colaborador × curso obrigatório com a situação de cada célula — a resposta
// direta a "quem está exercendo a função sem o treinamento". Base do Excel p/ auditoria.
// Perm 15004/15005/15003.

const { LER, requirePerm, trim, camel } = require('./_rh');

module.exports = (app) => ({
  verb: 'get',
  route: '/rh/matriz',
  middlewares: [requirePerm(app, LER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const filtros = ['c.ativo', 's.ativo', 's.obrigatorio'];
    const params = {};
    const depto = trim(req.query.depto);
    const cargo = trim(req.query.cargo);
    const trilha = Number(req.query.trilha) || 0;
    if (depto) { filtros.push('c.depto_desc = @depto'); params.depto = depto; }
    if (cargo) { filtros.push('c.cargo_codigo = @cargo'); params.cargo = cargo; }
    if (trilha) {
      filtros.push(`EXISTS (SELECT 1 FROM tab_uni_trilha_item ti WHERE ti.trilha_id = @trilha AND ti.curso_id = s.curso_id)`);
      params.trilha = trilha;
    }

    const rows = await Pg.connectAndQuery(`
      SELECT c.id AS colaborador_id, c.nome, c.matricula, c.cargo_desc, c.depto_desc, c.admissao::text AS admissao,
             s.curso_id, cu.codigo AS curso_codigo, cu.titulo AS curso_titulo,
             s.situacao, s.prazo::text AS prazo, s.evidencia_data::text AS evidencia_data, s.valido_ate::text AS valido_ate
        FROM vw_uni_requisito_situacao s
        JOIN tab_uni_colaborador c ON c.id = s.colaborador_id
        JOIN tab_uni_curso cu      ON cu.id = s.curso_id
       WHERE ${filtros.join(' AND ')}
       ORDER BY c.nome, cu.codigo`, params);

    const cursos = new Map();
    const linhas = new Map();
    for (const r0 of rows) {
      const r = camel(r0);
      if (!cursos.has(r.cursoId)) cursos.set(r.cursoId, { id: r.cursoId, codigo: r.cursoCodigo, titulo: r.cursoTitulo });
      if (!linhas.has(r.colaboradorId)) {
        linhas.set(r.colaboradorId, {
          colaboradorId: r.colaboradorId, nome: r.nome, matricula: r.matricula,
          cargo: r.cargoDesc, departamento: r.deptoDesc, admissao: r.admissao, celulas: {}
        });
      }
      linhas.get(r.colaboradorId).celulas[r.cursoId] = {
        situacao: r.situacao, prazo: r.prazo, evidenciaData: r.evidenciaData, validoAte: r.validoAte
      };
    }

    return res.json({
      cursos: [...cursos.values()].sort((a, b) => String(a.codigo).localeCompare(String(b.codigo))),
      linhas: [...linhas.values()]
    });
  }
});

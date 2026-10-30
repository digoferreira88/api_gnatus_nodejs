// GET /universidade/rh/colaboradores?q=&depto=&cargo=&situacao=&inativos=1
// Lista de colaboradores (espelho do Protheus) com o placar dos requisitos obrigatórios.
// situacao: em_dia | pendente | irregular | sem_trilha. Perm 15004/15005/15003.

const { LER, requirePerm, trim, camel, situacaoGeral } = require('./_rh');

module.exports = (app) => ({
  verb: 'get',
  route: '/rh/colaboradores',
  middlewares: [requirePerm(app, LER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const q = trim(req.query.q);
    const depto = trim(req.query.depto);
    const cargo = trim(req.query.cargo);
    const situacao = trim(req.query.situacao);
    const inativos = String(req.query.inativos || '') === '1';

    const filtros = [];
    const params = {};
    if (!inativos) filtros.push('c.ativo');
    if (q) {
      const dig = q.replace(/\D/g, '');
      filtros.push(`(c.nome ILIKE @q OR c.email ILIKE @q OR c.cargo_desc ILIKE @q${dig.length >= 3 ? ' OR c.matricula LIKE @dig OR c.cpf LIKE @dig' : ''})`);
      params.q = `%${q}%`;
      if (dig.length >= 3) params.dig = `%${dig}%`;
    }
    if (depto) { filtros.push('c.depto_desc = @depto'); params.depto = depto; }
    if (cargo) { filtros.push('c.cargo_codigo = @cargo'); params.cargo = cargo; }

    const rows = await Pg.connectAndQuery(`
      SELECT c.id, c.nome, c.filial, c.matricula, c.email, c.cargo_codigo, c.cargo_desc, c.depto_desc,
             c.admissao::text AS admissao, c.cargo_desde::text AS cargo_desde, c.ativo, c.situacao AS situacao_folha,
             (c.user_id IS NOT NULL) AS tem_login,
             count(s.id)::int AS total,
             count(*) FILTER (WHERE s.situacao = 'em_dia')::int        AS em_dia,
             count(*) FILTER (WHERE s.situacao = 'a_vencer')::int      AS a_vencer,
             count(*) FILTER (WHERE s.situacao = 'pendente')::int      AS pendente,
             count(*) FILTER (WHERE s.situacao = 'atrasado')::int      AS atrasado,
             count(*) FILTER (WHERE s.situacao = 'vencido')::int       AS vencido,
             count(*) FILTER (WHERE s.situacao = 'desatualizado')::int AS desatualizado,
             count(*) FILTER (WHERE s.situacao = 'dispensado')::int    AS dispensado,
             MIN(s.prazo) FILTER (WHERE s.situacao IN ('pendente','atrasado'))::text AS proximo_prazo
        FROM tab_uni_colaborador c
        LEFT JOIN vw_uni_requisito_situacao s ON s.colaborador_id = c.id AND s.ativo AND s.obrigatorio
       ${filtros.length ? 'WHERE ' + filtros.join(' AND ') : ''}
       GROUP BY c.id
       ORDER BY c.nome`, params);

    let lista = rows.map(r => {
      const o = camel(r);
      o.situacaoGeral = situacaoGeral(r);
      return o;
    });
    if (situacao) lista = lista.filter(x => x.situacaoGeral === situacao);

    const deptos = await Pg.connectAndQuery(`
      SELECT DISTINCT depto_desc FROM tab_uni_colaborador WHERE ativo AND COALESCE(depto_desc, '') <> '' ORDER BY 1`);

    return res.json({
      total: lista.length,
      colaboradores: lista,
      departamentos: deptos.map(d => d.depto_desc)
    });
  }
});

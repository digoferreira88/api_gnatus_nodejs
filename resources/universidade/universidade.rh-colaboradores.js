// GET /universidade/rh/colaboradores?q=&depto=&cargo=&situacao=&inativos=1
// Lista de colaboradores (espelho do Protheus) com o placar dos requisitos obrigatórios
// e o número de reprovações. situacao: em_dia | pendente | irregular | sem_trilha.
// Perm 15004/15005/15003.

const { LER, requirePerm, trim, consultaColaboradores } = require('./_rh');

module.exports = (app) => ({
  verb: 'get',
  route: '/rh/colaboradores',
  middlewares: [requirePerm(app, LER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const situacao = trim(req.query.situacao);
    let lista = await consultaColaboradores(Pg, {
      q: trim(req.query.q), depto: trim(req.query.depto), cargo: trim(req.query.cargo),
      inativos: String(req.query.inativos || '') === '1'
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

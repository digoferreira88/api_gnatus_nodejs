// GET /universidade/rh/registros?cursoId=&de=&ate=&q=&origem=
// Lançamentos de treinamento (lotes) com os participantes. Os 300 mais recentes.
// Perm 15004/15005/15003.

const { LER, requirePerm, trim, int, dataISO, camel } = require('./_rh');

module.exports = (app) => ({
  verb: 'get',
  route: '/rh/registros',
  middlewares: [requirePerm(app, LER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const filtros = [];
    const params = {};
    const cursoId = int(req.query.cursoId);
    const de = dataISO(req.query.de);
    const ate = dataISO(req.query.ate);
    const q = trim(req.query.q);
    const origem = trim(req.query.origem);
    if (cursoId) { filtros.push('l.curso_id = @cursoId'); params.cursoId = cursoId; }
    if (de) { filtros.push('l.data_realizacao >= @de'); params.de = de; }
    if (ate) { filtros.push('l.data_realizacao <= @ate'); params.ate = ate; }
    if (origem) { filtros.push('l.origem = @origem'); params.origem = origem; }
    if (q) {
      filtros.push(`(cu.titulo ILIKE @q OR cu.codigo ILIKE @q OR l.instrutor ILIKE @q OR EXISTS (
        SELECT 1 FROM tab_uni_registro r2 JOIN tab_uni_colaborador c2 ON c2.id = r2.colaborador_id
         WHERE r2.lote_id = l.id AND (c2.nome ILIKE @q OR c2.matricula ILIKE @q)))`);
      params.q = `%${q}%`;
    }

    const lotes = await Pg.connectAndQuery(`
      SELECT l.id, l.curso_id, cu.codigo AS curso_codigo, cu.titulo AS curso_titulo, v.revisao,
             l.data_realizacao::text AS data_realizacao, l.carga_h, l.modalidade, l.instrutor, l.local,
             l.verificacao, l.observacao, l.origem, (l.anexo_path IS NOT NULL) AS tem_anexo, l.anexo_nome,
             l.criado_em, u.nome AS criado_por
        FROM tab_uni_registro_lote l
        JOIN tab_uni_curso cu ON cu.id = l.curso_id
        LEFT JOIN tab_uni_curso_versao v ON v.id = l.versao_id
        LEFT JOIN tab_intranet_usr u ON u.id = l.criado_por
       ${filtros.length ? 'WHERE ' + filtros.join(' AND ') : ''}
       ORDER BY l.data_realizacao DESC, l.id DESC
       LIMIT 300`, params);

    const ids = lotes.map(l => l.id);
    const parts = ids.length ? await Pg.connectAndQuery(`
      SELECT r.id, r.lote_id, r.colaborador_id, c.nome, c.matricula, c.depto_desc, r.resultado, r.nota,
             r.anulado, r.anulado_motivo, r.anulado_em, ua.nome AS anulado_por
        FROM tab_uni_registro r
        JOIN tab_uni_colaborador c ON c.id = r.colaborador_id
        LEFT JOIN tab_intranet_usr ua ON ua.id = r.anulado_por
       WHERE r.lote_id = ANY(@ids::int[])
       ORDER BY c.nome`, { ids }) : [];

    return res.json({
      lotes: lotes.map(l => ({
        ...camel(l),
        participantes: parts.filter(p => p.lote_id === l.id).map(camel)
      }))
    });
  }
});

// GET /treinamentos/admin/participantes?treinamentoId=&sessaoId=&modalidade=&departamento=&status=&q=
// Lista de participantes (para consulta + exportação no front). Perm 20001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([20001, 0]);
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/admin/participantes',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const cond = [], p = {};
    const add = (c, k, v) => { cond.push(c); p[k] = v; };
    if (Number(req.query.treinamentoId)) add('i.treinamento_id=@tid', 'tid', Number(req.query.treinamentoId));
    if (Number(req.query.sessaoId)) add('i.sessao_id=@sid', 'sid', Number(req.query.sessaoId));
    const modal = trim(req.query.modalidade).toLowerCase();
    if (['presencial', 'online'].includes(modal)) add('i.modalidade=@mod', 'mod', modal);
    const st = trim(req.query.status).toLowerCase();
    if (['ativa', 'cancelada'].includes(st)) add('i.status=@st', 'st', st);
    if (trim(req.query.departamento)) add('i.departamento ILIKE @dep', 'dep', `%${trim(req.query.departamento)}%`);
    if (trim(req.query.q)) add('(i.colaborador_nome ILIKE @q OR i.colaborador_email ILIKE @q)', 'q', `%${trim(req.query.q)}%`);
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT i.id, i.colaborador_nome, i.colaborador_email, i.departamento, i.cargo,
               i.modalidade, i.status, i.criado_em,
               t.id treinamento_id, t.titulo,
               s.id sessao_id, s.data, s.hora_inicio, s.hora_fim
          FROM tab_treina_inscricao i
          JOIN tab_treina_treinamento t ON t.id=i.treinamento_id
          JOIN tab_treina_sessao s ON s.id=i.sessao_id
          ${where}
         ORDER BY t.titulo, s.data, i.colaborador_nome
         LIMIT 5000`, p);

      const participantes = rows.map(r => ({
        id: r.id, nome: trim(r.colaborador_nome), email: trim(r.colaborador_email),
        departamento: trim(r.departamento), cargo: trim(r.cargo),
        treinamentoId: r.treinamento_id, treinamento: r.titulo,
        sessaoId: r.sessao_id, data: r.data ? new Date(r.data).toISOString().slice(0, 10) : '',
        horaInicio: trim(r.hora_inicio), horaFim: trim(r.hora_fim),
        modalidade: trim(r.modalidade), status: trim(r.status), inscritoEm: r.criado_em
      }));
      return res.json({ total: participantes.length, participantes });
    } catch (err) {
      console.error('treinamentos/admin-participantes:', err.message);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

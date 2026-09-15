// GET /treinamentos/minhas — inscrições do colaborador logado (ativas + histórico).
const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/minhas',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });
    const uid = Number(user.id);
    const hoje = new Date().toISOString().slice(0, 10);

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT i.id, i.modalidade, i.status, i.criado_em, i.treinamento_id,
               t.titulo, t.instrutor, t.setor_responsavel, t.local_padrao, t.teams_link t_link, t.permite_cancelamento, t.permite_troca_sessao,
               s.id sessao_id, s.data, s.hora_inicio, s.hora_fim, s.local, s.teams_link s_link
          FROM tab_treina_inscricao i
          JOIN tab_treina_treinamento t ON t.id = i.treinamento_id
          JOIN tab_treina_sessao s ON s.id = i.sessao_id
         WHERE i.colaborador_id = @uid
         ORDER BY (i.status='ativa') DESC, s.data DESC`, { uid });

      const inscricoes = rows.map(r => {
        const dataISO = r.data ? new Date(r.data).toISOString().slice(0, 10) : '';
        const t = { teams_link: r.t_link }, s = { teams_link: r.s_link };
        return {
          id: r.id, modalidade: trim(r.modalidade), status: trim(r.status),
          treinamentoId: r.treinamento_id, titulo: r.titulo, instrutor: trim(r.instrutor),
          setorResponsavel: trim(r.setor_responsavel),
          sessaoId: r.sessao_id, data: dataISO, horaInicio: trim(r.hora_inicio), horaFim: trim(r.hora_fim),
          local: trim(r.local) || trim(r.local_padrao),
          linkOnline: trim(r.modalidade) === 'online' ? Treina.linkOnline(t, s) : '',
          futura: dataISO ? dataISO >= hoje : true,
          permiteCancelamento: r.permite_cancelamento !== false,
          permiteTrocaSessao: r.permite_troca_sessao !== false,
          inscritoEm: r.criado_em
        };
      });

      return res.json({ hoje, inscricoes });
    } catch (err) {
      console.error('treinamentos/minhas:', err.message);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

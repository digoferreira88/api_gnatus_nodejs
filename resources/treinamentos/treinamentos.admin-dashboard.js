// GET /treinamentos/admin/dashboard — visão gerencial: KPIs + tabela por sessão. Perm 20001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([20001, 0]);
const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/admin/dashboard',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const hoje = new Date().toISOString().slice(0, 10);
    try {
      const kt = await Pg.connectAndQuery(`
        SELECT COUNT(*) FILTER (WHERE status='publicado') ativos,
               COUNT(*) FILTER (WHERE status='encerrado') encerrados,
               COUNT(*) FILTER (WHERE status='rascunho') rascunhos
          FROM tab_treina_treinamento`, {});
      const ki = await Pg.connectAndQuery(`
        SELECT COUNT(*) FILTER (WHERE status='ativa') inscricoes,
               COUNT(*) FILTER (WHERE status='ativa' AND modalidade='presencial') presenciais,
               COUNT(*) FILTER (WHERE status='ativa' AND modalidade='online') online
          FROM tab_treina_inscricao`, {});

      // sessões dos treinamentos publicados (agendadas), com online por sessão
      const sessoes = await Pg.connectAndQuery(`
        SELECT s.id, s.data, s.hora_inicio, s.hora_fim, s.capacidade, s.ocupadas, s.status,
               t.id treinamento_id, t.titulo, t.status t_status,
               COALESCE(o.online,0) online
          FROM tab_treina_sessao s
          JOIN tab_treina_treinamento t ON t.id=s.treinamento_id
          LEFT JOIN (SELECT sessao_id, COUNT(*) online FROM tab_treina_inscricao WHERE modalidade='online' AND status='ativa' GROUP BY sessao_id) o ON o.sessao_id=s.id
         WHERE t.status IN ('publicado','encerrado')
         ORDER BY s.data, t.titulo`, {});

      let vagasDisp = 0, lotadas = 0;
      const linhas = sessoes.map(s => {
        const st = Treina.statusSessao(s, hoje);
        if (s.t_status === 'publicado' && trim(s.status) === 'agendada' && st.status !== 'encerrada') vagasDisp += st.disponiveis;
        if (st.status === 'lotada') lotadas++;
        return {
          sessaoId: s.id, treinamentoId: s.treinamento_id, treinamento: s.titulo,
          data: s.data ? new Date(s.data).toISOString().slice(0, 10) : '',
          horario: Treina.horario(s), capacidade: st.capacidade, presenciais: st.ocupadas,
          disponiveis: st.disponiveis, online: N(s.online), statusSessao: st.status
        };
      });

      return res.json({
        hoje,
        kpis: {
          treinamentosAtivos: N(kt[0].ativos), treinamentosEncerrados: N(kt[0].encerrados), rascunhos: N(kt[0].rascunhos),
          inscricoes: N(ki[0].inscricoes), presenciais: N(ki[0].presenciais), online: N(ki[0].online),
          vagasDisponiveis: vagasDisp, sessoesLotadas: lotadas
        },
        sessoes: linhas
      });
    } catch (err) {
      console.error('treinamentos/admin-dashboard:', err.message);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

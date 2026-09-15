// GET /treinamentos/admin/treinamentos — todos os treinamentos (qualquer status) com
// sessões aninhadas + contadores. Alimenta a listagem e o modal de edição. Perm 20001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([20001, 0]);
const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/admin/treinamentos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const hoje = new Date().toISOString().slice(0, 10);
    try {
      const treinos = await Pg.connectAndQuery(`
        SELECT id, titulo, descricao, objetivo, instrutor, setor_responsavel, local_padrao,
               teams_link, modalidades, status, permite_cancelamento, permite_troca_sessao, criado_em
          FROM tab_treina_treinamento ORDER BY id DESC`, {});
      const sessoes = await Pg.connectAndQuery(`
        SELECT s.id, s.treinamento_id, s.data, s.hora_inicio, s.hora_fim, s.local, s.teams_link,
               s.capacidade, s.ocupadas, s.status, s.educacional_event_id,
               COALESCE(o.online,0) online
          FROM tab_treina_sessao s
          LEFT JOIN (SELECT sessao_id, COUNT(*) online FROM tab_treina_inscricao WHERE modalidade='online' AND status='ativa' GROUP BY sessao_id) o ON o.sessao_id=s.id
         ORDER BY s.data, s.hora_inicio`, {});

      // Convidados por treinamento (+ quantos já se inscreveram)
      const conv = await Pg.connectAndQuery(`
        SELECT c.treinamento_id,
               COUNT(*) AS convidados,
               COUNT(i.id) AS inscritos
          FROM tab_treina_convite c
          LEFT JOIN tab_treina_inscricao i
                 ON i.treinamento_id=c.treinamento_id
                AND lower(i.colaborador_email)=lower(c.email) AND i.status='ativa'
         GROUP BY c.treinamento_id`, {});
      const mapConv = new Map();
      conv.forEach(r => mapConv.set(Number(r.treinamento_id), { convidados: Number(r.convidados), inscritos: Number(r.inscritos) }));

      const porTreino = new Map();
      sessoes.forEach(s => {
        const st = Treina.statusSessao(s, hoje);
        if (!porTreino.has(s.treinamento_id)) porTreino.set(s.treinamento_id, []);
        porTreino.get(s.treinamento_id).push({
          id: s.id, data: s.data ? new Date(s.data).toISOString().slice(0, 10) : '',
          horaInicio: trim(s.hora_inicio), horaFim: trim(s.hora_fim), local: trim(s.local), teamsLink: trim(s.teams_link),
          capacidade: st.capacidade, ocupadas: st.ocupadas, disponiveis: st.disponiveis,
          online: Number(s.online || 0), statusSessao: st.status, status: trim(s.status),
          teamsGerado: !!trim(s.educacional_event_id)
        });
      });

      const treinamentos = treinos.map(t => {
        const ss = porTreino.get(t.id) || [];
        const presenciais = ss.reduce((a, x) => a + x.ocupadas, 0);
        const online = ss.reduce((a, x) => a + x.online, 0);
        const capacidade = ss.reduce((a, x) => a + x.capacidade, 0);
        return {
          id: t.id, titulo: t.titulo, descricao: t.descricao, objetivo: t.objetivo,
          instrutor: trim(t.instrutor), setorResponsavel: trim(t.setor_responsavel),
          localPadrao: trim(t.local_padrao), teamsLink: trim(t.teams_link), modalidades: trim(t.modalidades),
          status: trim(t.status), permiteCancelamento: t.permite_cancelamento !== false, permiteTrocaSessao: t.permite_troca_sessao !== false,
          sessoes: ss,
          convidados: (mapConv.get(t.id) || { convidados: 0, inscritos: 0 }),
          totais: { sessoes: ss.length, presenciais, online, capacidade, inscritos: presenciais + online, lotadas: ss.filter(x => x.statusSessao === 'lotada').length }
        };
      });
      return res.json({ hoje, treinamentos });
    } catch (err) {
      console.error('treinamentos/admin-lista:', err.message);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

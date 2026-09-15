// GET /treinamentos — catálogo do colaborador: treinamentos publicados/encerrados
// com suas sessões (status de lotação calculado) + a inscrição ativa do usuário.
// Autenticado (qualquer colaborador).

const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const uid = user ? Number(user.id) : 0;
    const hoje = new Date().toISOString().slice(0, 10);

    try {
      const treinos = await Pg.connectAndQuery(`
        SELECT id, titulo, descricao, objetivo, instrutor, setor_responsavel, local_padrao,
               teams_link, modalidades, status, permite_cancelamento, permite_troca_sessao
          FROM tab_treina_treinamento
         WHERE status IN ('publicado','encerrado')
         ORDER BY status='publicado' DESC, id DESC`, {});
      if (!treinos.length) return res.json({ hoje, treinamentos: [] });

      const ids = treinos.map(t => t.id);
      const inList = ids.map((_, i) => `@t${i}`).join(',');
      const p = {}; ids.forEach((id, i) => { p[`t${i}`] = id; });

      // Sessões + contagem de online ativos por sessão
      const sessoes = await Pg.connectAndQuery(`
        SELECT s.id, s.treinamento_id, s.data, s.hora_inicio, s.hora_fim, s.local, s.teams_link,
               s.capacidade, s.ocupadas, s.status,
               COALESCE(o.online, 0) AS online
          FROM tab_treina_sessao s
          LEFT JOIN (
            SELECT sessao_id, COUNT(*) online FROM tab_treina_inscricao
             WHERE modalidade='online' AND status='ativa' GROUP BY sessao_id
          ) o ON o.sessao_id = s.id
         WHERE s.treinamento_id IN (${inList})
         ORDER BY s.data, s.hora_inicio`, p);

      // Inscrição ATIVA do usuário por treinamento
      const minhas = uid ? await Pg.connectAndQuery(`
        SELECT i.id, i.treinamento_id, i.sessao_id, i.modalidade, s.data, s.hora_inicio, s.hora_fim
          FROM tab_treina_inscricao i JOIN tab_treina_sessao s ON s.id = i.sessao_id
         WHERE i.colaborador_id=@uid AND i.status='ativa' AND i.treinamento_id IN (${inList})`, { ...p, uid }) : [];
      const mapMinha = new Map();
      minhas.forEach(m => mapMinha.set(m.treinamento_id, {
        id: m.id, sessaoId: m.sessao_id, modalidade: trim(m.modalidade),
        data: m.data ? new Date(m.data).toISOString().slice(0, 10) : ''
      }));

      const sessoesPorTreino = new Map();
      sessoes.forEach(s => {
        const st = Treina.statusSessao(s, hoje);
        const item = {
          id: s.id, data: s.data ? new Date(s.data).toISOString().slice(0, 10) : '',
          horaInicio: trim(s.hora_inicio), horaFim: trim(s.hora_fim),
          local: trim(s.local), teamsLink: trim(s.teams_link),
          capacidade: st.capacidade, ocupadas: st.ocupadas, disponiveis: st.disponiveis,
          online: Number(s.online || 0), statusSessao: st.status
        };
        if (!sessoesPorTreino.has(s.treinamento_id)) sessoesPorTreino.set(s.treinamento_id, []);
        sessoesPorTreino.get(s.treinamento_id).push(item);
      });

      const treinamentos = treinos.map(t => ({
        id: t.id, titulo: t.titulo, descricao: t.descricao, objetivo: t.objetivo,
        instrutor: trim(t.instrutor), setorResponsavel: trim(t.setor_responsavel),
        localPadrao: trim(t.local_padrao), teamsLink: trim(t.teams_link),
        modalidades: trim(t.modalidades), status: trim(t.status),
        permiteCancelamento: t.permite_cancelamento !== false,
        permiteTrocaSessao: t.permite_troca_sessao !== false,
        minhaInscricao: mapMinha.get(t.id) || null,
        sessoes: sessoesPorTreino.get(t.id) || []
      }));

      return res.json({ hoje, treinamentos });
    } catch (err) {
      console.error('treinamentos/catalogo:', err.message);
      return res.status(500).json({ message: 'Erro ao carregar treinamentos: ' + err.message });
    }
  }
});

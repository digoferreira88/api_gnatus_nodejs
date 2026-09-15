// GET /treinamentos/convite/:token   (ANÔNIMO — página pública, sem login)
// Valida o token do convite e devolve o treinamento + sessões (status de lotação),
// os dados do convidado (e-mail/nome) e a inscrição ativa dele, se houver.

const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

module.exports = (app) => ({
  verb: 'get',
  route: '/convite/:token',
  anonymous: true,

  handler: async (req, res) => {
    const { Pg } = app.services;
    const token = trim(req.params.token);
    if (!token || token.length < 10) return res.status(400).json({ estado: 'INVALIDO', message: 'Link inválido.' });

    try {
      const cv = await Pg.connectAndQuery(
        `SELECT id, treinamento_id, email, nome FROM tab_treina_convite WHERE token=@t`, { t: token });
      if (!cv.length) return res.status(404).json({ estado: 'INVALIDO', message: 'Convite não encontrado.' });
      const convite = cv[0];

      const view = await Treina.viewPublica(app, convite.treinamento_id);
      if (!view) return res.status(404).json({ estado: 'INVALIDO', message: 'Treinamento não encontrado.' });

      // Inscrição ativa deste convidado (amarrada ao convite)
      const insc = await Pg.connectAndQuery(`
        SELECT i.id, i.sessao_id, i.modalidade, s.data, s.hora_inicio, s.hora_fim, s.local, s.teams_link
          FROM tab_treina_inscricao i JOIN tab_treina_sessao s ON s.id=i.sessao_id
         WHERE i.convite_id=@cid AND i.status='ativa' LIMIT 1`, { cid: convite.id });
      const minhaInscricao = insc.length ? {
        id: insc[0].id, sessaoId: insc[0].sessao_id, modalidade: trim(insc[0].modalidade),
        data: isoDate(insc[0].data), horaInicio: trim(insc[0].hora_inicio), horaFim: trim(insc[0].hora_fim),
        local: trim(insc[0].local),
        linkOnline: trim(insc[0].modalidade) === 'online' ? trim(insc[0].teams_link) : ''
      } : null;

      const estado = view.treinamento.status === 'publicado' ? 'ABERTO' : (minhaInscricao ? 'ABERTO' : 'FECHADO');
      return res.json({
        estado,
        modo: 'convite',
        convidado: { email: trim(convite.email), nome: trim(convite.nome) },
        treinamento: view.treinamento,
        sessoes: view.sessoes,
        minhaInscricao
      });
    } catch (err) {
      console.error('treinamentos/convite-get:', err.message);
      return res.status(500).json({ message: 'Erro ao carregar o convite.' });
    }
  }
});

// GET /treinamentos/publico/:ptoken   (ANÔNIMO — link público compartilhável)
// Auto-atendimento: o treinamento é resolvido pelo public_token; o participante
// informa nome+e-mail na hora de inscrever. Não expõe dados de outros participantes.

const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/publico/:ptoken',
  anonymous: true,

  handler: async (req, res) => {
    const { Pg } = app.services;
    const ptoken = trim(req.params.ptoken);
    if (!ptoken || ptoken.length < 10) return res.status(400).json({ estado: 'INVALIDO', message: 'Link inválido.' });

    try {
      const tr = await Pg.connectAndQuery(
        `SELECT id, status FROM tab_treina_treinamento WHERE public_token=@t`, { t: ptoken });
      if (!tr.length) return res.status(404).json({ estado: 'INVALIDO', message: 'Treinamento não encontrado.' });

      const view = await Treina.viewPublica(app, tr[0].id);
      if (!view) return res.status(404).json({ estado: 'INVALIDO', message: 'Treinamento não encontrado.' });

      const estado = view.treinamento.status === 'publicado' ? 'ABERTO' : 'FECHADO';
      return res.json({ estado, modo: 'publico', treinamento: view.treinamento, sessoes: view.sessoes });
    } catch (err) {
      console.error('treinamentos/publico-get:', err.message);
      return res.status(500).json({ message: 'Erro ao carregar o treinamento.' });
    }
  }
});

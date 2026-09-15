// GET /treinamentos/admin/convites?treinamentoId= — lista de convidados de um
// treinamento, cruzando com as inscrições ativas p/ mostrar quem já escolheu data.
// Perm 20001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([20001, 0]);
const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();
const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

module.exports = (app) => ({
  verb: 'get',
  route: '/admin/convites',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.query.treinamentoId) || 0;
    if (!id) return res.status(400).json({ message: 'treinamentoId é obrigatório.' });

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT c.id, c.email, c.nome, c.token, c.convidado_em, c.reenviado_em,
               i.id AS inscricao_id, i.sessao_id, i.modalidade, i.status AS insc_status,
               s.data AS sessao_data, s.hora_inicio, s.hora_fim
          FROM tab_treina_convite c
          LEFT JOIN tab_treina_inscricao i
                 ON i.treinamento_id = c.treinamento_id
                AND lower(i.colaborador_email) = lower(c.email)
                AND i.status = 'ativa'
          LEFT JOIN tab_treina_sessao s ON s.id = i.sessao_id
         WHERE c.treinamento_id = @id
         ORDER BY (i.id IS NOT NULL) DESC, c.convidado_em`, { id });

      const convites = rows.map(r => ({
        id: r.id, email: trim(r.email), nome: trim(r.nome),
        link: r.token ? Treina.linkConvite(trim(r.token)) : '',
        convidadoEm: r.convidado_em, reenviadoEm: r.reenviado_em,
        inscrito: !!r.inscricao_id,
        inscricao: r.inscricao_id ? {
          id: r.inscricao_id, sessaoId: r.sessao_id, modalidade: trim(r.modalidade),
          data: isoDate(r.sessao_data), horaInicio: trim(r.hora_inicio), horaFim: trim(r.hora_fim)
        } : null
      }));

      const inscritos = convites.filter(c => c.inscrito).length;
      return res.json({
        treinamentoId: id,
        convites,
        totais: { convidados: convites.length, inscritos, pendentes: convites.length - inscritos }
      });
    } catch (err) {
      console.error('treinamentos/admin-convites:', err.message);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

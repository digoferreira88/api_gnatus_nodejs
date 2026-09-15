// POST /treinamentos/convite/:token/inscrever   (ANÔNIMO — sem login)
// body: { sessaoId, modalidade: 'presencial'|'online', nome? }
// O convidado escolhe a data. Mesma reserva de vaga à prova de concorrência
// (núcleo Treina.inscreverConvidado, amarrada ao convite). Best-effort: e-mail
// de confirmação + evento de calendário.

const Auditoria = require('../../services/auditoria');
const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();

const MSG = {
  JA_INSCRITO: 'Você já está inscrito(a) neste treinamento.',
  LOTADA: 'Esta data está LOTADA — sem vagas presenciais. Escolha outra data.',
  INDISPONIVEL: 'Esta data não está mais disponível.'
};

module.exports = (app) => ({
  verb: 'post',
  route: '/convite/:token/inscrever',
  anonymous: true,

  handler: async (req, res) => {
    const { Pg } = app.services;
    const token = trim(req.params.token);
    const b = req.body || {};
    const sid = Number(b.sessaoId) || 0;
    const modalidade = trim(b.modalidade).toLowerCase();
    const nomeInput = trim(b.nome).slice(0, 120);
    if (!token || token.length < 10) return res.status(400).json({ message: 'Link inválido.' });
    if (!sid) return res.status(400).json({ message: 'Escolha uma data.' });
    if (!['presencial', 'online'].includes(modalidade)) return res.status(400).json({ message: 'Modalidade inválida.' });

    try {
      const cv = await Pg.connectAndQuery(
        `SELECT id, treinamento_id, email, nome FROM tab_treina_convite WHERE token=@t`, { t: token });
      if (!cv.length) return res.status(404).json({ message: 'Convite não encontrado.' });
      const convite = cv[0];

      // Treinamento + sessão (linha completa p/ validação e efeitos)
      const rows = await Pg.connectAndQuery(`
        SELECT t.id t_id, t.titulo, t.descricao, t.objetivo, t.instrutor, t.setor_responsavel,
               t.local_padrao, t.teams_link t_link, t.modalidades, t.status t_status,
               s.id s_id, s.data, s.hora_inicio, s.hora_fim, s.local, s.teams_link s_link,
               s.capacidade, s.ocupadas, s.status s_status
          FROM tab_treina_sessao s JOIN tab_treina_treinamento t ON t.id=s.treinamento_id
         WHERE s.id=@sid AND t.id=@tid`, { sid, tid: convite.treinamento_id });
      if (!rows.length) return res.status(404).json({ message: 'Data/treinamento não encontrado.' });
      const r = rows[0];
      if (trim(r.t_status) !== 'publicado') return res.status(409).json({ message: 'As inscrições deste treinamento não estão abertas.' });
      if (trim(r.s_status) !== 'agendada') return res.status(409).json({ message: 'Esta data está indisponível.' });
      const mods = trim(r.modalidades);
      if (modalidade === 'online' && mods === 'presencial') return res.status(409).json({ message: 'Este treinamento não oferece participação online.' });
      if (modalidade === 'presencial' && mods === 'online') return res.status(409).json({ message: 'Este treinamento é somente online.' });

      // Atualiza o nome do convite se ainda não temos (pro registro do participante)
      const nomeFinal = trim(convite.nome) || nomeInput;
      if (!trim(convite.nome) && nomeInput) {
        await Pg.connectAndQuery(`UPDATE tab_treina_convite SET nome=@n WHERE id=@id`, { n: nomeInput, id: convite.id });
      }

      // Pré-checagem amigável: já existe inscrição ativa p/ este e-mail neste treinamento?
      const dup = await Pg.connectAndQuery(`
        SELECT 1 FROM tab_treina_inscricao
         WHERE treinamento_id=@tid AND status='ativa' AND lower(colaborador_email)=lower(@email) LIMIT 1`,
        { tid: convite.treinamento_id, email: trim(convite.email) });
      if (dup.length) return res.status(409).json({ message: MSG.JA_INSCRITO, codigo: 'JA_INSCRITO' });

      const treinamento = { id: r.t_id, titulo: r.titulo, descricao: r.descricao, objetivo: r.objetivo, instrutor: r.instrutor, setor_responsavel: r.setor_responsavel, local_padrao: r.local_padrao, teams_link: r.t_link };
      const sessao = { id: r.s_id, data: r.data, hora_inicio: r.hora_inicio, hora_fim: r.hora_fim, local: r.local, teams_link: r.s_link, capacidade: r.capacidade, ocupadas: r.ocupadas, status: r.s_status };

      const ins = await Treina.inscreverConvidado(app, {
        convite: { id: convite.id, email: trim(convite.email), nome: nomeFinal }, treinamento, sessao, modalidade
      });
      if (!ins.ok) return res.status(409).json({ message: MSG[ins.codigo] || 'Não foi possível inscrever.', codigo: ins.codigo });

      // Efeitos best-effort (e-mail de confirmação ao convidado + calendário se ligado)
      const ef = await Treina.efeitosInscricao(app, {
        inscricao: { id: ins.inscricaoId }, treinamento, sessao, modalidade,
        email: trim(convite.email), nome: nomeFinal
      });

      Auditoria.registrar(app, {
        modulo: 'Treinamentos', submodulo: 'InscricaoPublica', acao: 'INSCREVER', severidade: 'INFO',
        req, usuarioEmail: trim(convite.email), usuarioNome: nomeFinal,
        entidade: 'inscricao', entidadeId: String(ins.inscricaoId),
        descricao: `Convidado inscreveu-se (${modalidade}) em "${treinamento.titulo}" via link do convite`,
        meta: { treinamentoId: convite.treinamento_id, sessaoId: sid, conviteId: convite.id, modalidade }
      });

      return res.json({
        ok: true, modalidade,
        data: Treina.iso(sessao.data), horaInicio: trim(sessao.hora_inicio), horaFim: trim(sessao.hora_fim),
        local: modalidade === 'presencial' ? Treina.localSessao(treinamento, sessao) : '',
        linkOnline: modalidade === 'online' ? Treina.linkOnline(treinamento, sessao) : '',
        emailEnviado: ef.avisos.length === 0
      });
    } catch (err) {
      console.error('treinamentos/convite-inscrever:', err.message);
      return res.status(500).json({ message: 'Erro ao inscrever: ' + err.message });
    }
  }
});

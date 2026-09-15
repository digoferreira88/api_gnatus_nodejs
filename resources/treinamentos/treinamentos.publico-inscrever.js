// POST /treinamentos/publico/:ptoken/inscrever   (ANÔNIMO — link público)
// body: { nome, email, sessaoId, modalidade }
// Auto-atendimento: registra/acha o convite pelo e-mail (assim o participante
// aparece nos "convidados" do admin) e inscreve pelo núcleo Treina.inscreverConvidado.

const Auditoria = require('../../services/auditoria');
const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MSG = {
  JA_INSCRITO: 'Este e-mail já está inscrito neste treinamento.',
  LOTADA: 'Esta data está LOTADA — sem vagas presenciais. Escolha outra data.',
  INDISPONIVEL: 'Esta data não está mais disponível.'
};

module.exports = (app) => ({
  verb: 'post',
  route: '/publico/:ptoken/inscrever',
  anonymous: true,

  handler: async (req, res) => {
    const { Pg } = app.services;
    const ptoken = trim(req.params.ptoken);
    const b = req.body || {};
    const nome = trim(b.nome).slice(0, 120);
    const email = trim(b.email).toLowerCase().slice(0, 190);
    const sid = Number(b.sessaoId) || 0;
    const modalidade = trim(b.modalidade).toLowerCase();
    if (!ptoken || ptoken.length < 10) return res.status(400).json({ message: 'Link inválido.' });
    if (!nome) return res.status(400).json({ message: 'Informe seu nome.' });
    if (!EMAIL_RX.test(email)) return res.status(400).json({ message: 'Informe um e-mail válido.' });
    if (!sid) return res.status(400).json({ message: 'Escolha uma data.' });
    if (!['presencial', 'online'].includes(modalidade)) return res.status(400).json({ message: 'Modalidade inválida.' });

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT t.id t_id, t.titulo, t.descricao, t.objetivo, t.instrutor, t.setor_responsavel,
               t.local_padrao, t.teams_link t_link, t.modalidades, t.status t_status,
               s.id s_id, s.data, s.hora_inicio, s.hora_fim, s.local, s.teams_link s_link,
               s.capacidade, s.ocupadas, s.status s_status
          FROM tab_treina_treinamento t
          JOIN tab_treina_sessao s ON s.treinamento_id=t.id AND s.id=@sid
         WHERE t.public_token=@t`, { t: ptoken, sid });
      if (!rows.length) return res.status(404).json({ message: 'Treinamento/data não encontrado.' });
      const r = rows[0];
      const tid = r.t_id;
      if (trim(r.t_status) !== 'publicado') return res.status(409).json({ message: 'As inscrições deste treinamento não estão abertas.' });
      if (trim(r.s_status) !== 'agendada') return res.status(409).json({ message: 'Esta data está indisponível.' });
      const mods = trim(r.modalidades);
      if (modalidade === 'online' && mods === 'presencial') return res.status(409).json({ message: 'Este treinamento não oferece participação online.' });
      if (modalidade === 'presencial' && mods === 'online') return res.status(409).json({ message: 'Este treinamento é somente online.' });

      // Upsert do convite pelo e-mail (participante entra nos "convidados" do admin)
      const ins = await Pg.connectAndQuery(
        `INSERT INTO tab_treina_convite (treinamento_id, email, nome, token)
         VALUES (@tid, @email, @nome, @token)
         ON CONFLICT (treinamento_id, lower(email)) DO NOTHING
         RETURNING id`, { tid, email, nome, token: Treina.novoToken() });
      let conviteId;
      if (ins.length) { conviteId = ins[0].id; }
      else {
        const ex = await Pg.connectAndQuery(
          `SELECT id, nome FROM tab_treina_convite WHERE treinamento_id=@tid AND lower(email)=lower(@email)`, { tid, email });
        conviteId = ex[0].id;
        if (!trim(ex[0].nome) && nome) await Pg.connectAndQuery(`UPDATE tab_treina_convite SET nome=@n WHERE id=@id`, { n: nome, id: conviteId });
      }

      // Pré-checagem amigável de duplicidade por e-mail
      const dup = await Pg.connectAndQuery(`
        SELECT 1 FROM tab_treina_inscricao
         WHERE treinamento_id=@tid AND status='ativa' AND lower(colaborador_email)=lower(@email) LIMIT 1`, { tid, email });
      if (dup.length) return res.status(409).json({ message: MSG.JA_INSCRITO, codigo: 'JA_INSCRITO' });

      const treinamento = { id: r.t_id, titulo: r.titulo, descricao: r.descricao, objetivo: r.objetivo, instrutor: r.instrutor, setor_responsavel: r.setor_responsavel, local_padrao: r.local_padrao, teams_link: r.t_link };
      const sessao = { id: r.s_id, data: r.data, hora_inicio: r.hora_inicio, hora_fim: r.hora_fim, local: r.local, teams_link: r.s_link, capacidade: r.capacidade, ocupadas: r.ocupadas, status: r.s_status };

      const enr = await Treina.inscreverConvidado(app, { convite: { id: conviteId, email, nome }, treinamento, sessao, modalidade });
      if (!enr.ok) return res.status(409).json({ message: MSG[enr.codigo] || 'Não foi possível inscrever.', codigo: enr.codigo });

      const ef = await Treina.efeitosInscricao(app, { inscricao: { id: enr.inscricaoId }, treinamento, sessao, modalidade, email, nome });

      Auditoria.registrar(app, {
        modulo: 'Treinamentos', submodulo: 'InscricaoPublica', acao: 'INSCREVER', severidade: 'INFO',
        req, usuarioEmail: email, usuarioNome: nome,
        entidade: 'inscricao', entidadeId: String(enr.inscricaoId),
        descricao: `Inscrição pública (${modalidade}) em "${treinamento.titulo}" via link compartilhado`,
        meta: { treinamentoId: tid, sessaoId: sid, conviteId, modalidade }
      });

      return res.json({
        ok: true, modalidade,
        data: Treina.iso(sessao.data), horaInicio: trim(sessao.hora_inicio), horaFim: trim(sessao.hora_fim),
        local: modalidade === 'presencial' ? Treina.localSessao(treinamento, sessao) : '',
        linkOnline: modalidade === 'online' ? Treina.linkOnline(treinamento, sessao) : '',
        emailEnviado: ef.avisos.length === 0
      });
    } catch (err) {
      console.error('treinamentos/publico-inscrever:', err.message);
      return res.status(500).json({ message: 'Erro ao inscrever: ' + err.message });
    }
  }
});

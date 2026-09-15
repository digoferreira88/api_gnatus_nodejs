// POST /treinamentos/inscrever   body: { treinamentoId, sessaoId, modalidade: 'presencial'|'online' }
// CORAÇÃO DO MÓDULO — reserva de vaga à prova de concorrência.
//
// Presencial: UPDATE atômico `ocupadas=ocupadas+1 WHERE ocupadas<capacidade` + INSERT
// da inscrição num ÚNICO statement (CTE). O lock de linha do Postgres serializa
// reservas simultâneas: nunca passa da capacidade, nunca gera vaga negativa. O
// índice UNIQUE parcial (treinamento,colaborador WHERE ativa) barra duplicidade —
// e como é 1 statement, a violação do unique DESFAZ o incremento (sem vazar vaga).
// Online: não toca no contador. Autenticado (qualquer colaborador).

const Auditoria = require('../../services/auditoria');
const Treina = require('../../services/treinamentos');
const M365 = require('../../services/m365');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/inscrever',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });
    const uid = Number(user.id);
    const nome = trim(user.nome);
    const email = trim(user.email);

    const b = req.body || {};
    const tid = Number(b.treinamentoId) || 0;
    const sid = Number(b.sessaoId) || 0;
    const modalidade = trim(b.modalidade).toLowerCase();
    if (!tid || !sid) return res.status(400).json({ message: 'treinamentoId e sessaoId são obrigatórios.' });
    if (!['presencial', 'online'].includes(modalidade)) return res.status(400).json({ message: 'modalidade inválida.' });

    try {
      // Valida treinamento publicado + sessão pertence a ele + modalidade permitida
      const rows = await Pg.connectAndQuery(`
        SELECT t.id t_id, t.titulo, t.descricao, t.objetivo, t.instrutor, t.setor_responsavel,
               t.local_padrao, t.teams_link t_link, t.modalidades, t.status t_status,
               s.id s_id, s.data, s.hora_inicio, s.hora_fim, s.local, s.teams_link s_link,
               s.capacidade, s.ocupadas, s.status s_status
          FROM tab_treina_sessao s
          JOIN tab_treina_treinamento t ON t.id = s.treinamento_id
         WHERE s.id = @sid AND t.id = @tid`, { sid, tid });
      if (!rows.length) return res.status(404).json({ message: 'Sessão/treinamento não encontrado.' });
      const r = rows[0];
      const treinamento = { id: r.t_id, titulo: r.titulo, descricao: r.descricao, objetivo: r.objetivo, instrutor: r.instrutor, setor_responsavel: r.setor_responsavel, local_padrao: r.local_padrao, teams_link: r.t_link };
      const sessao = { id: r.s_id, data: r.data, hora_inicio: r.hora_inicio, hora_fim: r.hora_fim, local: r.local, teams_link: r.s_link, capacidade: r.capacidade, ocupadas: r.ocupadas, status: r.s_status };

      if (trim(r.t_status) !== 'publicado') return res.status(409).json({ message: 'Treinamento não está com inscrições abertas.' });
      if (trim(r.s_status) !== 'agendada') return res.status(409).json({ message: 'Sessão indisponível.' });
      const mods = trim(r.modalidades);
      if (modalidade === 'online' && mods === 'presencial') return res.status(409).json({ message: 'Este treinamento não oferece participação online.' });
      if (modalidade === 'presencial' && mods === 'online') return res.status(409).json({ message: 'Este treinamento é somente online.' });

      let inscricaoId = null, capacidade = r.capacidade, ocupadas = r.ocupadas;

      if (modalidade === 'presencial') {
        // ATÔMICO: incrementa só se houver vaga; insere a inscrição no mesmo statement.
        let out;
        try {
          out = await Pg.connectAndQuery(`
            WITH s AS (
              UPDATE tab_treina_sessao
                 SET ocupadas = ocupadas + 1
               WHERE id = @sid AND treinamento_id = @tid AND status = 'agendada' AND ocupadas < capacidade
              RETURNING id, treinamento_id, capacidade, ocupadas
            ),
            ins AS (
              INSERT INTO tab_treina_inscricao
                (treinamento_id, sessao_id, colaborador_id, colaborador_nome, colaborador_email, modalidade, status)
              SELECT treinamento_id, id, @uid, @nome, @email, 'presencial', 'ativa' FROM s
              RETURNING id
            )
            SELECT ins.id inscricao_id, s.capacidade, s.ocupadas FROM ins, s`,
            { sid, tid, uid, nome: nome || null, email: email || null });
        } catch (e) {
          if (e.code === '23505') return res.status(409).json({ message: 'Você já possui inscrição neste treinamento.', codigo: 'JA_INSCRITO' });
          throw e;
        }
        if (!out.length) {
          // não incrementou → sessão lotada (ou virou indisponível na corrida)
          const chk = await Pg.connectAndQuery(`SELECT capacidade, ocupadas, status FROM tab_treina_sessao WHERE id=@sid`, { sid });
          const lot = chk[0] && Number(chk[0].ocupadas) >= Number(chk[0].capacidade);
          return res.status(409).json({ message: lot ? 'Sessão LOTADA — sem vagas presenciais.' : 'Não foi possível reservar a vaga.', codigo: lot ? 'LOTADA' : 'INDISPONIVEL' });
        }
        inscricaoId = out[0].inscricao_id; capacidade = Number(out[0].capacidade); ocupadas = Number(out[0].ocupadas);
      } else {
        // ONLINE — sem consumir vaga
        let out;
        try {
          out = await Pg.connectAndQuery(`
            INSERT INTO tab_treina_inscricao
              (treinamento_id, sessao_id, colaborador_id, colaborador_nome, colaborador_email, modalidade, status)
            SELECT @tid, @sid, @uid, @nome, @email, 'online', 'ativa'
             WHERE EXISTS (SELECT 1 FROM tab_treina_sessao WHERE id=@sid AND treinamento_id=@tid AND status='agendada')
            RETURNING id`,
            { sid, tid, uid, nome: nome || null, email: email || null });
        } catch (e) {
          if (e.code === '23505') return res.status(409).json({ message: 'Você já possui inscrição neste treinamento.', codigo: 'JA_INSCRITO' });
          throw e;
        }
        if (!out.length) return res.status(409).json({ message: 'Sessão indisponível.' });
        inscricaoId = out[0].id;
      }

      // Snapshot depto/cargo (best-effort, não bloqueia)
      try {
        const perfil = await M365.perfilPorEmail(email);
        if (perfil) await Pg.connectAndQuery(`UPDATE tab_treina_inscricao SET departamento=@d, cargo=@c WHERE id=@id`,
          { d: perfil.departamento || null, c: perfil.cargo || null, id: inscricaoId });
      } catch (e) { /* ignora */ }

      // Efeitos: calendário M365 + e-mail (best-effort)
      const ef = await Treina.efeitosInscricao(app, { inscricao: { id: inscricaoId }, treinamento, sessao, modalidade, email, nome });

      Auditoria.registrar(app, {
        modulo: 'Treinamentos', submodulo: 'Inscricao', acao: 'INSCREVER', severidade: 'INFO',
        req, entidade: 'inscricao', entidadeId: String(inscricaoId),
        descricao: `Inscrição ${modalidade} em "${treinamento.titulo}" (sessão ${Treina.fmtDataBR(Treina.iso(sessao.data))})`,
        meta: { treinamentoId: tid, sessaoId: sid, modalidade }
      });

      return res.json({
        ok: true, inscricaoId, modalidade,
        disponiveis: modalidade === 'presencial' ? Math.max(0, capacidade - ocupadas) : null,
        calendarioCriado: !!ef.calendarEventId,
        avisos: ef.avisos.length ? ef.avisos : undefined,
        linkOnline: modalidade === 'online' ? Treina.linkOnline(treinamento, sessao) : undefined
      });
    } catch (err) {
      console.error('treinamentos/inscrever:', err.message);
      return res.status(500).json({ message: 'Erro ao inscrever: ' + err.message });
    }
  }
});

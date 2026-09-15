// POST /treinamentos/admin/inscricao/:id  body: { acao: 'cancelar'|'mover', sessaoId? }
// Admin cancela uma inscrição (libera vaga) ou move o participante de sessão
// (troca de vaga atômica: pega a nova só se houver espaço, devolve a antiga). Perm 20001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([20001, 0]);
const Auditoria = require('../../services/auditoria');
const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/admin/inscricao/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id) || 0;
    const acao = trim(req.body?.acao).toLowerCase();
    if (!id) return res.status(400).json({ message: 'id inválido.' });

    try {
      const pre = await Pg.connectAndQuery(`
        SELECT i.id, i.modalidade, i.status, i.sessao_id, i.treinamento_id, i.calendar_event_id,
               i.colaborador_email, i.colaborador_nome, t.titulo, s.data, s.hora_inicio, s.hora_fim
          FROM tab_treina_inscricao i
          JOIN tab_treina_treinamento t ON t.id=i.treinamento_id
          JOIN tab_treina_sessao s ON s.id=i.sessao_id
         WHERE i.id=@id AND i.status='ativa'`, { id });
      if (!pre.length) return res.status(404).json({ message: 'Inscrição ativa não encontrada.' });
      const p = pre[0];

      if (acao === 'cancelar') {
        await Pg.connectAndQuery(`
          WITH c AS (
            UPDATE tab_treina_inscricao SET status='cancelada', cancelado_em=NOW(), cancelado_por=@uid
             WHERE id=@id AND status='ativa' RETURNING sessao_id, modalidade
          )
          UPDATE tab_treina_sessao s SET ocupadas=GREATEST(0,ocupadas-1)
            FROM c WHERE s.id=c.sessao_id AND c.modalidade='presencial'`, { id, uid: user?.id ? Number(user.id) : null });
        await Treina.removerEventoInscricao(app, { email: trim(p.colaborador_email), calendarEventId: trim(p.calendar_event_id) });
        await Treina.avisarPorEmail(trim(p.colaborador_email), { nome: trim(p.colaborador_nome), tipo: 'cancelamento', treinamento: { titulo: p.titulo }, sessao: { data: p.data, hora_inicio: p.hora_inicio, hora_fim: p.hora_fim } });
        Auditoria.registrar(app, { modulo: 'Treinamentos', submodulo: 'Admin', acao: 'CANCELAR_INSCRICAO', severidade: 'AVISO', req, entidade: 'inscricao', entidadeId: String(id), descricao: `Admin cancelou inscrição de ${trim(p.colaborador_nome)} em "${p.titulo}"` });
        return res.json({ ok: true, acao });
      }

      if (acao === 'mover') {
        const nova = Number(req.body?.sessaoId) || 0;
        if (!nova) return res.status(400).json({ message: 'sessaoId (destino) obrigatório.' });
        if (nova === p.sessao_id) return res.status(400).json({ message: 'Participante já está nesta sessão.' });
        const vs = await Pg.connectAndQuery(`SELECT id FROM tab_treina_sessao WHERE id=@nova AND treinamento_id=@tid AND status='agendada'`, { nova, tid: p.treinamento_id });
        if (!vs.length) return res.status(409).json({ message: 'Sessão de destino inválida (outro treinamento ou cancelada).' });

        if (trim(p.modalidade) === 'presencial') {
          // Atômico: ocupa a nova (se houver vaga), devolve a antiga, move a inscrição.
          const out = await Pg.connectAndQuery(`
            WITH nova AS (
              UPDATE tab_treina_sessao SET ocupadas=ocupadas+1
               WHERE id=@nova AND status='agendada' AND ocupadas<capacidade RETURNING id
            ),
            antiga AS (
              UPDATE tab_treina_sessao SET ocupadas=GREATEST(0,ocupadas-1)
               WHERE id=@antiga AND EXISTS (SELECT 1 FROM nova) RETURNING id
            ),
            mov AS (
              UPDATE tab_treina_inscricao SET sessao_id=@nova
               WHERE id=@id AND status='ativa' AND EXISTS (SELECT 1 FROM nova) RETURNING id
            )
            SELECT mov.id FROM mov`, { nova, antiga: p.sessao_id, id });
          if (!out.length) return res.status(409).json({ message: 'Sessão de destino LOTADA — não há vaga presencial.', codigo: 'LOTADA' });
        } else {
          await Pg.connectAndQuery(`UPDATE tab_treina_inscricao SET sessao_id=@nova WHERE id=@id AND status='ativa'`, { nova, id });
        }
        await Treina.avisarPorEmail(trim(p.colaborador_email), { nome: trim(p.colaborador_nome), tipo: 'sessao_alterada', treinamento: { titulo: p.titulo }, sessao: { data: p.data, hora_inicio: p.hora_inicio, hora_fim: p.hora_fim } });
        Auditoria.registrar(app, { modulo: 'Treinamentos', submodulo: 'Admin', acao: 'MOVER_INSCRICAO', severidade: 'INFO', req, entidade: 'inscricao', entidadeId: String(id), descricao: `Admin moveu ${trim(p.colaborador_nome)} de sessão em "${p.titulo}"`, meta: { de: p.sessao_id, para: nova } });
        return res.json({ ok: true, acao, sessaoId: nova });
      }

      return res.status(400).json({ message: 'ação inválida (cancelar|mover).' });
    } catch (err) {
      console.error('treinamentos/admin-inscricao:', err.message);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

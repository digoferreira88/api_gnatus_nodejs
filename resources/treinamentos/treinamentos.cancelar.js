// POST /treinamentos/inscricao/:id/cancelar — colaborador cancela a PRÓPRIA inscrição.
// Presencial: devolve a vaga à sessão (decremento atômico, no mesmo statement).
// Remove o evento do calendário (best-effort) e avisa por e-mail. Autenticado.

const Auditoria = require('../../services/auditoria');
const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/inscricao/:id/cancelar',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });
    const uid = Number(user.id);
    const id = Number(req.params.id) || 0;
    if (!id) return res.status(400).json({ message: 'id inválido.' });

    try {
      // Pré-checagem: inscrição do próprio, ativa, e treinamento permite cancelar
      const pre = await Pg.connectAndQuery(`
        SELECT i.id, i.modalidade, i.treinamento_id, i.sessao_id, i.calendar_event_id, i.colaborador_email,
               i.colaborador_nome, t.titulo, t.permite_cancelamento, s.data, s.hora_inicio, s.hora_fim
          FROM tab_treina_inscricao i
          JOIN tab_treina_treinamento t ON t.id = i.treinamento_id
          JOIN tab_treina_sessao s ON s.id = i.sessao_id
         WHERE i.id = @id AND i.colaborador_id = @uid AND i.status = 'ativa'`, { id, uid });
      if (!pre.length) return res.status(404).json({ message: 'Inscrição ativa não encontrada.' });
      const p = pre[0];
      if (p.permite_cancelamento === false) return res.status(403).json({ message: 'Cancelamento não permitido para este treinamento. Procure o setor Educacional.' });

      // Atômico: cancela a inscrição e (se presencial) devolve a vaga na sessão.
      const out = await Pg.connectAndQuery(`
        WITH c AS (
          UPDATE tab_treina_inscricao
             SET status='cancelada', cancelado_em=NOW(), cancelado_por=@uid
           WHERE id=@id AND colaborador_id=@uid AND status='ativa'
          RETURNING id, sessao_id, modalidade
        ),
        dec AS (
          UPDATE tab_treina_sessao s SET ocupadas = GREATEST(0, ocupadas - 1)
            FROM c WHERE s.id = c.sessao_id AND c.modalidade='presencial'
          RETURNING s.id
        )
        SELECT c.id, c.modalidade FROM c`, { id, uid });
      if (!out.length) return res.status(409).json({ message: 'Inscrição já não estava ativa.' });

      // Best-effort: remove evento do calendário + avisa
      await Treina.removerEventoInscricao(app, { email: trim(p.colaborador_email), calendarEventId: trim(p.calendar_event_id) });
      await Treina.avisarPorEmail(trim(p.colaborador_email), {
        nome: trim(p.colaborador_nome), tipo: 'cancelamento',
        treinamento: { titulo: p.titulo }, sessao: { data: p.data, hora_inicio: p.hora_inicio, hora_fim: p.hora_fim }
      });

      Auditoria.registrar(app, {
        modulo: 'Treinamentos', submodulo: 'Inscricao', acao: 'CANCELAR', severidade: 'INFO',
        req, entidade: 'inscricao', entidadeId: String(id),
        descricao: `Cancelou inscrição (${trim(out[0].modalidade)}) em "${p.titulo}"${trim(out[0].modalidade) === 'presencial' ? ' — vaga liberada' : ''}`
      });

      return res.json({ ok: true, vagaLiberada: trim(out[0].modalidade) === 'presencial' });
    } catch (err) {
      console.error('treinamentos/cancelar:', err.message);
      return res.status(500).json({ message: 'Erro ao cancelar: ' + err.message });
    }
  }
});

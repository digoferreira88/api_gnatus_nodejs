// POST /treinamentos/admin/treinamento/:id/status  body: { acao }
// acao: publicar | encerrar | reabrir | cancelar | excluir. Perm 20001.
// cancelar = cancela o treinamento + todas as inscrições ativas (libera vagas,
// notifica, remove eventos do calendário). excluir = só se não houver inscrição.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([20001, 0]);
const Auditoria = require('../../services/auditoria');
const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/admin/treinamento/:id/status',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id) || 0;
    const acao = trim(req.body?.acao).toLowerCase();
    if (!id) return res.status(400).json({ message: 'id inválido.' });
    if (!['publicar', 'encerrar', 'reabrir', 'cancelar', 'excluir'].includes(acao)) return res.status(400).json({ message: 'ação inválida.' });

    try {
      const ex = await Pg.connectAndQuery(`SELECT id, titulo, status FROM tab_treina_treinamento WHERE id=@id`, { id });
      if (!ex.length) return res.status(404).json({ message: 'Treinamento não encontrado.' });
      const t = ex[0];

      if (acao === 'publicar' || acao === 'reabrir') {
        const cnt = await Pg.connectAndQuery(`SELECT COUNT(*) n FROM tab_treina_sessao WHERE treinamento_id=@id AND status='agendada'`, { id });
        if (Number(cnt[0].n) === 0) return res.status(409).json({ message: 'Adicione ao menos 1 sessão agendada antes de publicar.' });
        await Pg.connectAndQuery(`UPDATE tab_treina_treinamento SET status='publicado', atualizado_em=NOW() WHERE id=@id`, { id });
      } else if (acao === 'encerrar') {
        await Pg.connectAndQuery(`UPDATE tab_treina_treinamento SET status='encerrado', atualizado_em=NOW() WHERE id=@id`, { id });
      } else if (acao === 'excluir') {
        const cnt = await Pg.connectAndQuery(`SELECT COUNT(*) n FROM tab_treina_inscricao WHERE treinamento_id=@id`, { id });
        if (Number(cnt[0].n) > 0) return res.status(409).json({ message: 'Treinamento tem inscrições — use "Cancelar" em vez de excluir.' });
        // Remove eventos/reservas de sala no calendário do organizador antes de apagar.
        const sessEv = await Pg.connectAndQuery(`SELECT id, educacional_event_id FROM tab_treina_sessao WHERE treinamento_id=@id AND educacional_event_id IS NOT NULL`, { id });
        for (const s of sessEv) await Treina.excluirReuniaoSessao(app, s);
        await Pg.connectAndQuery(`DELETE FROM tab_treina_treinamento WHERE id=@id`, { id });   // cascade sessões
      } else if (acao === 'cancelar') {
        // Notifica + remove calendário de cada inscrito ativo, depois cancela tudo.
        const ativos = await Pg.connectAndQuery(`
          SELECT i.id, i.colaborador_email, i.colaborador_nome, i.calendar_event_id, s.data, s.hora_inicio, s.hora_fim
            FROM tab_treina_inscricao i JOIN tab_treina_sessao s ON s.id=i.sessao_id
           WHERE i.treinamento_id=@id AND i.status='ativa'`, { id });
        for (const a of ativos) {
          await Treina.removerEventoInscricao(app, { email: trim(a.colaborador_email), calendarEventId: trim(a.calendar_event_id) });
          await Treina.avisarPorEmail(trim(a.colaborador_email), { nome: trim(a.colaborador_nome), tipo: 'treinamento_cancelado', treinamento: { titulo: t.titulo }, sessao: { data: a.data, hora_inicio: a.hora_inicio, hora_fim: a.hora_fim } });
        }
        await Pg.connectAndQuery(`UPDATE tab_treina_inscricao SET status='cancelada', cancelado_em=NOW(), cancelado_por=@uid WHERE treinamento_id=@id AND status='ativa'`, { id, uid: user?.id ? Number(user.id) : null });
        // Remove eventos/reservas de sala no calendário do organizador (libera as salas).
        const sessEv = await Pg.connectAndQuery(`SELECT id, educacional_event_id FROM tab_treina_sessao WHERE treinamento_id=@id AND educacional_event_id IS NOT NULL`, { id });
        for (const s of sessEv) await Treina.excluirReuniaoSessao(app, s);
        await Pg.connectAndQuery(`UPDATE tab_treina_sessao SET status='cancelada', ocupadas=0 WHERE treinamento_id=@id`, { id });
        await Pg.connectAndQuery(`UPDATE tab_treina_treinamento SET status='cancelado', atualizado_em=NOW() WHERE id=@id`, { id });
      }

      Auditoria.registrar(app, {
        modulo: 'Treinamentos', submodulo: 'Admin', acao: acao.toUpperCase(), severidade: acao === 'cancelar' || acao === 'excluir' ? 'AVISO' : 'INFO',
        req, entidade: 'treinamento', entidadeId: String(id),
        descricao: `${acao} treinamento "${t.titulo}" (de ${t.status})`
      });
      return res.json({ ok: true, id, acao });
    } catch (err) {
      console.error('treinamentos/admin-status:', err.message);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

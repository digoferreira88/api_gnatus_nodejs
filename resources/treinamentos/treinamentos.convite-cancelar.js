// POST /treinamentos/convite/:token/cancelar   (ANÔNIMO — sem login)
// O convidado cancela a PRÓPRIA inscrição (identificada pelo convite). Presencial
// devolve a vaga (decremento atômico). Best-effort: remove calendário + avisa.

const Auditoria = require('../../services/auditoria');
const Treina = require('../../services/treinamentos');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/convite/:token/cancelar',
  anonymous: true,

  handler: async (req, res) => {
    const { Pg } = app.services;
    const token = trim(req.params.token);
    if (!token || token.length < 10) return res.status(400).json({ message: 'Link inválido.' });

    try {
      const pre = await Pg.connectAndQuery(`
        SELECT i.id, i.modalidade, i.calendar_event_id, i.colaborador_email, i.colaborador_nome,
               t.titulo, t.permite_cancelamento, s.data, s.hora_inicio, s.hora_fim
          FROM tab_treina_convite c
          JOIN tab_treina_inscricao i ON i.convite_id=c.id AND i.status='ativa'
          JOIN tab_treina_treinamento t ON t.id=i.treinamento_id
          JOIN tab_treina_sessao s ON s.id=i.sessao_id
         WHERE c.token=@t`, { t: token });
      if (!pre.length) return res.status(404).json({ message: 'Nenhuma inscrição ativa para cancelar.' });
      const p = pre[0];
      if (p.permite_cancelamento === false) return res.status(403).json({ message: 'Cancelamento não permitido. Procure o setor Educacional.' });

      const out = await Pg.connectAndQuery(`
        WITH c AS (
          UPDATE tab_treina_inscricao SET status='cancelada', cancelado_em=NOW()
           WHERE id=@id AND status='ativa'
          RETURNING id, sessao_id, modalidade
        ),
        dec AS (
          UPDATE tab_treina_sessao s SET ocupadas = GREATEST(0, ocupadas - 1)
            FROM c WHERE s.id=c.sessao_id AND c.modalidade='presencial'
          RETURNING s.id
        )
        SELECT c.id, c.modalidade FROM c`, { id: p.id });
      if (!out.length) return res.status(409).json({ message: 'Inscrição já não estava ativa.' });

      await Treina.removerEventoInscricao(app, { email: trim(p.colaborador_email), calendarEventId: trim(p.calendar_event_id) });
      await Treina.avisarPorEmail(trim(p.colaborador_email), {
        nome: trim(p.colaborador_nome), tipo: 'cancelamento',
        treinamento: { titulo: p.titulo }, sessao: { data: p.data, hora_inicio: p.hora_inicio, hora_fim: p.hora_fim }
      });

      Auditoria.registrar(app, {
        modulo: 'Treinamentos', submodulo: 'InscricaoPublica', acao: 'CANCELAR', severidade: 'INFO',
        req, usuarioEmail: trim(p.colaborador_email), usuarioNome: trim(p.colaborador_nome),
        entidade: 'inscricao', entidadeId: String(p.id),
        descricao: `Convidado cancelou inscrição (${trim(out[0].modalidade)}) em "${p.titulo}" via link do convite`
      });

      return res.json({ ok: true, vagaLiberada: trim(out[0].modalidade) === 'presencial' });
    } catch (err) {
      console.error('treinamentos/convite-cancelar:', err.message);
      return res.status(500).json({ message: 'Erro ao cancelar: ' + err.message });
    }
  }
});

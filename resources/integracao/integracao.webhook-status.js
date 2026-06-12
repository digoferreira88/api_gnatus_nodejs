// GET /integracao/webhook-status — monitoramento dos webhooks Pipefy
// processados pela intranet: eventos recebidos, fila de WhatsApp e KPIs.
// Perm 1033.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1033]);
const trim = (v) => String(v == null ? '' : v).trim();

const PIPES = {
  '304770705': 'SAC Atendimento', '304292510': 'Não Conformidade', '304804154': 'Admissão Digital',
  '304866308': 'Trocas', '304912650': 'Devolução', '305698109': 'Jurídico SAC',
  '307050389': 'G-Care Interno', '306929743': 'Teste_TI', '304059336': 'Registro Histórico (OP)'
};

module.exports = (app) => ({
  verb: 'get',
  route: '/webhook-status',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const eventos = await Pg.connectAndQuery(
        `SELECT id, action, card_id, pipe_id, fase_id, fase_nome, processado, resultado, recebido_em
           FROM tab_pipefy_wh_evento ORDER BY id DESC LIMIT 40`, {});
      const fila = await Pg.connectAndQuery(
        `SELECT id, numero_telefone, card_id, fase_id, card_action, template_id, enviado, resposta, criado_em, enviado_em
           FROM tab_pipefy_wh_fila ORDER BY id DESC LIMIT 40`, {});
      const kpis = (await Pg.connectAndQuery(`
        SELECT
          (SELECT COUNT(*) FROM tab_pipefy_wh_evento WHERE recebido_em::date = CURRENT_DATE) eventos_hoje,
          (SELECT COUNT(*) FROM tab_pipefy_wh_evento) eventos_total,
          (SELECT COUNT(*) FROM tab_pipefy_wh_fila WHERE enviado = '1') wa_ok,
          (SELECT COUNT(*) FROM tab_pipefy_wh_fila WHERE enviado = '0') wa_falha,
          (SELECT COUNT(*) FROM tab_pipefy_wh_fila WHERE enviado = '') wa_pendente,
          (SELECT MAX(recebido_em) FROM tab_pipefy_wh_evento) ultimo_evento`, {}))[0];

      // mascara o telefone (LGPD básica na tela): 5516988...90
      const mascarar = (n) => { n = trim(n); return n.length >= 8 ? n.slice(0, 7) + '...' + n.slice(-2) : n; };

      return res.json({
        kpis: {
          eventosHoje: Number(kpis.eventos_hoje || 0), eventosTotal: Number(kpis.eventos_total || 0),
          waOk: Number(kpis.wa_ok || 0), waFalha: Number(kpis.wa_falha || 0), waPendente: Number(kpis.wa_pendente || 0),
          ultimoEvento: kpis.ultimo_evento
        },
        eventos: eventos.map(e => ({
          id: e.id, action: trim(e.action), cardId: trim(e.card_id),
          pipe: PIPES[trim(e.pipe_id)] || trim(e.pipe_id) || '—',
          fase: trim(e.fase_nome) || trim(e.fase_id), processado: !!e.processado,
          resultado: trim(e.resultado), em: e.recebido_em
        })),
        fila: fila.map(f => ({
          id: f.id, telefone: mascarar(f.numero_telefone), cardId: trim(f.card_id),
          action: trim(f.card_action), template: trim(f.template_id),
          status: f.enviado === '1' ? 'OK' : f.enviado === '0' ? 'FALHA' : 'PENDENTE',
          resposta: trim(f.resposta).slice(0, 220), em: f.criado_em, enviadoEm: f.enviado_em
        }))
      });
    } catch (err) {
      console.error('Erro webhook-status:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

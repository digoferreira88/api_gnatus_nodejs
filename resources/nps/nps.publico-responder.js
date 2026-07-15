// POST /nps/publico/:token  (ANÔNIMO)
// Body: { respostas: [{ perguntaId, nota?, texto?, opcao? }] }
// Grava as respostas, classifica o cliente pela pergunta NPS (e_nps) e fecha o
// convite. Idempotente: se já respondido, devolve estado RESPONDIDO.

const NPS = require('../../services/npsPosvenda');
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'post',
  route: '/publico/:token',
  anonymous: true,

  handler: async (req, res) => {
    const { Pg } = app.services;
    const token = trim(req.params.token);
    const respostas = Array.isArray(req.body?.respostas) ? req.body.respostas : [];
    if (!token) return res.status(400).json({ message: 'Link inválido.' });

    try {
      const rows = await Pg.connectAndQuery(
        `SELECT id, status, expira_em FROM tab_nps_convite WHERE token = @t`, { t: token });
      if (!rows.length) return res.status(404).json({ message: 'Pesquisa não encontrada.' });
      const conv = rows[0];
      if (trim(conv.status) === 'RESPONDIDO') return res.json({ estado: 'RESPONDIDO' });
      if (conv.expira_em && new Date(conv.expira_em) < new Date()) return res.status(410).json({ estado: 'EXPIRADO', message: 'Esta pesquisa expirou.' });

      const perguntas = await Pg.connectAndQuery(
        `SELECT id, texto, tipo, obrigatoria, e_nps FROM tab_nps_pergunta WHERE ativa = TRUE`, {});
      const pById = new Map(perguntas.map(p => [Number(p.id), p]));
      const respMap = new Map(respostas.map(r => [Number(r.perguntaId), r]));

      // valida obrigatórias
      for (const p of perguntas) {
        if (!p.obrigatoria) continue;
        const r = respMap.get(Number(p.id));
        const vazio = !r || (trim(p.tipo) === 'texto' ? !trim(r.texto)
          : trim(p.tipo) === 'opcao' ? !trim(r.opcao)
          : (r.nota == null || r.nota === ''));
        if (vazio) return res.status(400).json({ message: `Responda: "${trim(p.texto)}"`, perguntaId: p.id });
      }

      // acha a nota NPS
      const pNps = perguntas.find(p => p.e_nps);
      let notaNps = null;
      if (pNps) { const r = respMap.get(Number(pNps.id)); if (r && r.nota != null && r.nota !== '') notaNps = N(r.nota); }
      const cfg = await NPS.lerConfig(Pg);
      const classificacao = notaNps != null ? NPS.classificar(notaNps, cfg) : null;

      // grava respostas (upsert por pergunta)
      for (const r of respostas) {
        const p = pById.get(Number(r.perguntaId));
        if (!p) continue;
        await Pg.connectAndQuery(`
          INSERT INTO tab_nps_resposta (convite_id, pergunta_id, pergunta_texto, tipo, nota, texto, opcao)
          VALUES (@cid, @pid, @ptxt, @tipo, @nota, @texto, @opcao)
          ON CONFLICT (convite_id, pergunta_id) DO UPDATE SET
            nota = @nota, texto = @texto, opcao = @opcao, criado_em = NOW()`,
          {
            cid: conv.id, pid: p.id, ptxt: trim(p.texto), tipo: trim(p.tipo),
            nota: (r.nota == null || r.nota === '') ? null : N(r.nota),
            texto: trim(r.texto).slice(0, 4000) || null, opcao: trim(r.opcao).slice(0, 200) || null
          });
      }

      await Pg.connectAndQuery(`
        UPDATE tab_nps_convite
           SET status = 'RESPONDIDO', classificacao = @cls, nota_nps = @nota, respondido_em = NOW()
         WHERE id = @id`,
        { cls: classificacao, nota: notaNps, id: conv.id });

      return res.json({ estado: 'OBRIGADO', agradecimento: (cfg.mensagem && cfg.mensagem.agradecimento) || 'Obrigado pela sua resposta!' });
    } catch (err) {
      console.error('nps/publico-responder:', err);
      return res.status(500).json({ message: 'Erro ao registrar sua resposta.' });
    }
  }
});

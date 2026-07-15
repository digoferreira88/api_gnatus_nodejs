// POST /sac/nps/perguntas
// Body: { perguntas: [{ id?, ordem, texto, tipo, opcoes?, obrigatoria, eNps }] }
// Salva o conjunto de perguntas do CX. Upsert por id; perguntas existentes que
// NÃO vierem no payload são desativadas (soft-delete — preserva respostas
// históricas). Garante exatamente 1 pergunta NPS ativa. Perm 6003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6003]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const TIPOS = ['nps', 'escala', 'texto', 'opcao'];

module.exports = (app) => ({
  verb: 'post',
  route: '/nps/perguntas',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const lista = Array.isArray(req.body?.perguntas) ? req.body.perguntas : [];
    if (!lista.length) return res.status(400).json({ message: 'Envie ao menos uma pergunta.' });

    // valida + garante 1 NPS
    const npsCount = lista.filter(p => p.eNps || trim(p.tipo) === 'nps').length;
    const norm = lista.map((p, i) => {
      const tipo = TIPOS.includes(trim(p.tipo)) ? trim(p.tipo) : 'texto';
      return {
        id: p.id ? Number(p.id) : null,
        ordem: N(p.ordem) || (i + 1),
        texto: trim(p.texto).slice(0, 500),
        tipo,
        opcoes: tipo === 'opcao' && Array.isArray(p.opcoes) ? p.opcoes.map(o => trim(o)).filter(Boolean) : null,
        obrigatoria: p.obrigatoria !== false,
        eNps: tipo === 'nps' && !!p.eNps
      };
    }).filter(p => p.texto);

    if (!norm.some(p => p.eNps)) {
      // se ninguém marcou, elege a 1ª do tipo nps
      const firstNps = norm.find(p => p.tipo === 'nps');
      if (firstNps) firstNps.eNps = true;
      else return res.status(400).json({ message: 'É necessária uma pergunta do tipo NPS (0-10) para classificar o cliente.' });
    }
    // só 1 e_nps
    let achou = false;
    norm.forEach(p => { if (p.eNps) { if (achou) p.eNps = false; else achou = true; } });

    try {
      const mantidos = [];
      for (const p of norm) {
        if (p.id) {
          await Pg.connectAndQuery(`
            UPDATE tab_nps_pergunta SET ordem=@ordem, texto=@texto, tipo=@tipo, opcoes=@opcoes::jsonb,
                   obrigatoria=@obr, e_nps=@enps, ativa=TRUE, atualizado_em=NOW() WHERE id=@id`,
            { id: p.id, ordem: p.ordem, texto: p.texto, tipo: p.tipo, opcoes: p.opcoes ? JSON.stringify(p.opcoes) : null, obr: p.obrigatoria, enps: p.eNps });
          mantidos.push(p.id);
        } else {
          const r = await Pg.connectAndQuery(`
            INSERT INTO tab_nps_pergunta (ordem, texto, tipo, opcoes, obrigatoria, e_nps, ativa)
            VALUES (@ordem, @texto, @tipo, @opcoes::jsonb, @obr, @enps, TRUE) RETURNING id`,
            { ordem: p.ordem, texto: p.texto, tipo: p.tipo, opcoes: p.opcoes ? JSON.stringify(p.opcoes) : null, obr: p.obrigatoria, enps: p.eNps });
          mantidos.push(r[0].id);
        }
      }
      // desativa as que sumiram (preserva respostas)
      if (mantidos.length) {
        const inIds = mantidos.map((_, i) => `@k${i}`).join(',');
        const pk = {}; mantidos.forEach((id, i) => { pk[`k${i}`] = id; });
        await Pg.connectAndQuery(`UPDATE tab_nps_pergunta SET ativa=FALSE WHERE id NOT IN (${inIds})`, pk);
      }

      Auditoria.registrar(app, {
        modulo: 'SAC', submodulo: 'NPS', acao: 'PERGUNTAS', severidade: 'INFO', req,
        entidade: 'nps_pergunta', entidadeId: 'set',
        descricao: `Atualizou as perguntas do NPS (${mantidos.length} ativa(s))`,
        meta: { total: mantidos.length }
      });
      return res.json({ ok: true, ids: mantidos });
    } catch (err) {
      console.error('sac/nps-perguntas-salvar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

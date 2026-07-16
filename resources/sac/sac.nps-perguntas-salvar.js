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

    // Normaliza. A pergunta classificadora (eNps) pode ser 'nps'/'escala'
    // (por nota) OU 'opcao' (CSAT: cada opção mapeada p/ PROMOTOR/NEUTRO/DETRATOR).
    const CLS = ['PROMOTOR', 'NEUTRO', 'DETRATOR'];
    const norm = lista.map((p, i) => {
      const tipo = TIPOS.includes(trim(p.tipo)) ? trim(p.tipo) : 'texto';
      const opcoes = tipo === 'opcao' && Array.isArray(p.opcoes) ? p.opcoes.map(o => trim(o)).filter(Boolean) : null;
      let classMap = null;
      if (tipo === 'opcao' && p.classMap && typeof p.classMap === 'object') {
        classMap = {};
        (opcoes || []).forEach(o => { const v = trim(p.classMap[o]).toUpperCase(); if (CLS.includes(v)) classMap[o] = v; });
        if (!Object.keys(classMap).length) classMap = null;
      }
      return {
        id: p.id ? Number(p.id) : null,
        ordem: N(p.ordem) || (i + 1),
        texto: trim(p.texto).slice(0, 500),
        tipo, opcoes, classMap,
        obrigatoria: p.obrigatoria !== false,
        eNps: ['nps', 'escala', 'opcao'].includes(tipo) && !!p.eNps
      };
    }).filter(p => p.texto);

    if (!norm.some(p => p.eNps)) {
      const first = norm.find(p => ['nps', 'escala', 'opcao'].includes(p.tipo));
      if (first) first.eNps = true;
      else return res.status(400).json({ message: 'É necessária uma pergunta classificadora (NPS 0-10, escala 1-5 ou múltipla escolha) para classificar o cliente.' });
    }
    // só 1 e_nps
    let achou = false;
    norm.forEach(p => { if (p.eNps) { if (achou) p.eNps = false; else achou = true; } });

    // a classificadora do tipo 'opcao' precisa do mapa opção->classificação
    const clsQ = norm.find(p => p.eNps);
    if (clsQ && clsQ.tipo === 'opcao') {
      const semMap = (clsQ.opcoes || []).filter(o => !(clsQ.classMap && clsQ.classMap[o]));
      if (!clsQ.opcoes || clsQ.opcoes.length < 2 || semMap.length) {
        return res.status(400).json({ message: `Na pergunta classificadora, defina Promotor/Neutro/Detrator para cada opção${semMap.length ? ` (faltam: ${semMap.join(', ')})` : ''}.` });
      }
    }

    try {
      const mantidos = [];
      for (const p of norm) {
        const enpsCls = p.eNps && p.tipo === 'opcao' ? JSON.stringify(p.classMap) : null;
        if (p.id) {
          await Pg.connectAndQuery(`
            UPDATE tab_nps_pergunta SET ordem=@ordem, texto=@texto, tipo=@tipo, opcoes=@opcoes::jsonb,
                   class_map=@cmap::jsonb, obrigatoria=@obr, e_nps=@enps, ativa=TRUE, atualizado_em=NOW() WHERE id=@id`,
            { id: p.id, ordem: p.ordem, texto: p.texto, tipo: p.tipo, opcoes: p.opcoes ? JSON.stringify(p.opcoes) : null, cmap: enpsCls, obr: p.obrigatoria, enps: p.eNps });
          mantidos.push(p.id);
        } else {
          const r = await Pg.connectAndQuery(`
            INSERT INTO tab_nps_pergunta (ordem, texto, tipo, opcoes, class_map, obrigatoria, e_nps, ativa)
            VALUES (@ordem, @texto, @tipo, @opcoes::jsonb, @cmap::jsonb, @obr, @enps, TRUE) RETURNING id`,
            { ordem: p.ordem, texto: p.texto, tipo: p.tipo, opcoes: p.opcoes ? JSON.stringify(p.opcoes) : null, cmap: enpsCls, obr: p.obrigatoria, enps: p.eNps });
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

// PUT /qualificacao/config — altera chaves da configuração (só as conhecidas, com o
// tipo certo). body: { chave: valor, ... }. Perm 23006 (Administração).

const Q = require('../../services/qfCore');

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const VALIDAR = {
  emails_qualidade: (v) => Array.isArray(v) && v.every(emailOk),
  emails_engenharia: (v) => Array.isArray(v) && v.every(emailOk),
  acoes_automaticas: (v) => typeof v === 'boolean',
  suspender_doc_vencido: (v) => typeof v === 'boolean',
  suspender_requalificacao_vencida: (v) => typeof v === 'boolean',
  dias_alerta_requalificacao: (v) => Array.isArray(v) && v.length > 0 && v.every(n => Number.isInteger(n) && n >= 30 && n <= 180),
  email_fornecedor: (v) => typeof v === 'boolean',
  dias_alerta_documento: (v) => Array.isArray(v) && v.length > 0 && v.every(n => Number.isInteger(n) && n >= 0 && n <= 365),
  questionario_validade_dias: (v) => Number.isInteger(v) && v >= 1 && v <= 180
};

module.exports = (app) => ({
  verb: 'put',
  route: '/config',
  middlewares: [Q.mw(app, 'admin')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    const u = Q.usuario(req);
    try {
      const atuais = await Pg.connectAndQuery(`SELECT chave, valor FROM tab_qf_config`);
      const porChave = new Map(atuais.map(a => [a.chave, a.valor]));
      const mud = [];
      for (const [k, v] of Object.entries(b)) {
        if (k === 'motivo') continue;
        if (!VALIDAR[k]) return res.status(400).json({ message: `Chave desconhecida: ${k}.` });
        const valor = Array.isArray(v) && k.startsWith('emails_') ? [...new Set(v.map(e => String(e).trim().toLowerCase()).filter(Boolean))] : v;
        if (!VALIDAR[k](valor)) return res.status(400).json({ message: `Valor inválido para ${k}.` });
        if (JSON.stringify(porChave.get(k)) === JSON.stringify(valor)) continue;
        await Pg.connectAndQuery(
          `INSERT INTO tab_qf_config (chave, valor, atualizado_por, atualizado_em) VALUES (@k, @v::jsonb, @u, NOW())
           ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()`,
          { k, v: JSON.stringify(valor), u: u.id });
        mud.push({ campo: k, de: porChave.get(k), para: valor });
      }
      if (mud.length) await Q.log(Pg, req, { entidade: 'config', acao: 'ALTERAR', mudancas: mud, motivo: b.motivo });
      return res.json({ ok: true, alteradas: mud.map(m => m.campo) });
    } catch (err) { return Q.falha(res, 'salvar a configuração', err); }
  }
});

// PUT /expedicao/config — atualiza a config do módulo (ativo, dataInicio,
// expiraDias, mensagem). Upsert por chave em tab_expedicao_config. Perm 12003.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([12003, 0]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'put',
  route: '/config',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    const updates = [];

    if (typeof b.ativo === 'boolean') updates.push(['ativo', JSON.stringify(b.ativo)]);
    if (b.dataInicio !== undefined) {
      const d = trim(b.dataInicio);
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ message: 'dataInicio inválida (use YYYY-MM-DD).' });
      updates.push(['dataInicio', JSON.stringify(d || null)]);
    }
    if (b.expiraDias !== undefined) updates.push(['expiraDias', JSON.stringify(Math.min(Math.max(parseInt(b.expiraDias, 10) || 15, 1), 90))]);
    if (b.mensagem !== undefined && b.mensagem && typeof b.mensagem === 'object') updates.push(['mensagem', JSON.stringify(b.mensagem)]);

    if (!updates.length) return res.status(400).json({ message: 'Nada para atualizar.' });

    try {
      for (const [k, v] of updates) {
        await Pg.connectAndQuery(
          `INSERT INTO tab_expedicao_config (chave, valor) VALUES (@k, @v::jsonb)
           ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`, { k, v });
      }
      Auditoria.registrar(app, {
        modulo: 'Expedicao', submodulo: 'ConfirmacaoRecebimento', acao: 'UPDATE', severidade: 'AVISO',
        req, entidade: 'expedicao_config',
        descricao: `Atualizou config do aviso de recebimento (${updates.map(u => u[0]).join(', ')})`,
        meta: { chaves: updates.map(u => u[0]) }
      });
      return res.json({ ok: true, atualizados: updates.map(u => u[0]) });
    } catch (err) {
      console.error('expedicao/config PUT:', err);
      return res.status(500).json({ message: 'Erro ao salvar a configuração.' });
    }
  }
});

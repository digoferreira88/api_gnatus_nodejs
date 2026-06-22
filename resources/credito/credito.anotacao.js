// POST /credito/anotacao  — salva (upsert) as anotações do time de um cliente na
// Análise de Crédito. 1 registro por cliente (cod+loja), compartilhado. Perm 15100.
// Body: { cod, loja, anotacoes }

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([15100]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/anotacao',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = (req.user && req.user[0]) || {};
    const b = req.body || {};
    const cod = trim(b.cod), loja = trim(b.loja);
    if (!cod || !loja) return res.status(400).json({ message: 'cod e loja são obrigatórios.' });
    const anotacoes = trim(b.anotacoes).slice(0, 8000);
    const nome = trim(user.NOME) || trim(user.EMAIL) || `id_${user.ID}`;

    try {
      await Pg.connectAndQuery(`
        INSERT INTO tab_credito_anotacao (cliente_cod, cliente_loja, anotacoes, atualizado_por, atualizado_por_nome, atualizado_em)
        VALUES (@cod, @loja, @a, @uid, @nome, NOW())
        ON CONFLICT (cliente_cod, cliente_loja) DO UPDATE SET
          anotacoes=@a, atualizado_por=@uid, atualizado_por_nome=@nome, atualizado_em=NOW()`,
        { cod, loja, a: anotacoes, uid: user.ID, nome });

      Auditoria.registrar(app, {
        modulo: 'Crédito', submodulo: 'Análise', acao: 'ANOTAR', severidade: 'INFO', req,
        entidade: 'cliente', entidadeId: `${cod}/${loja}`,
        descricao: `Anotou cliente ${cod}/${loja} (Análise de Crédito)`,
        meta: { anotacoes: anotacoes.slice(0, 200) }
      });

      return res.json({ ok: true, anotacao: { texto: anotacoes, por: nome, em: new Date().toISOString() } });
    } catch (err) {
      console.error('credito/anotacao:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

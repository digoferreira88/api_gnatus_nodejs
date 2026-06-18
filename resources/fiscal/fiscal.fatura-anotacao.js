// POST /fiscal/fatura-anotacao
// Salva (upsert) a ação + observação de um pedido na Fila de Faturamento
// (Painel Fiscal). 1 registro por pedido, compartilhado entre operadores.
// Tabela própria do fiscal (não mistura com a Liberação Financeira). Perm 16001.
// Body: { pedido, acoes?, observacoes? }

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/fatura-anotacao',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = (req.user && req.user[0]) || {};
    const b = req.body || {};

    const pedido = trim(b.pedido);
    if (!pedido) return res.status(400).json({ message: 'pedido é obrigatório.' });
    if (pedido.length > 10) return res.status(400).json({ message: 'pedido inválido.' });

    const acoes = trim(b.acoes).slice(0, 4000);
    const observacoes = trim(b.observacoes).slice(0, 4000);
    const nome = trim(user.NOME) || trim(user.EMAIL) || `id_${user.ID}`;

    try {
      await Pg.connectAndQuery(`
        INSERT INTO tab_fiscal_fatura_anotacao
          (filial, pedido, acoes, observacoes, atualizado_por, atualizado_por_nome, criado_em, atualizado_em)
        VALUES ('01', @pedido, @acoes, @obs, @uid, @nome, NOW(), NOW())
        ON CONFLICT (filial, pedido) DO UPDATE SET
          acoes               = EXCLUDED.acoes,
          observacoes         = EXCLUDED.observacoes,
          atualizado_por      = EXCLUDED.atualizado_por,
          atualizado_por_nome = EXCLUDED.atualizado_por_nome,
          atualizado_em       = NOW()`,
        { pedido, acoes, obs: observacoes, uid: user.ID, nome }
      );

      Auditoria.registrar(app, {
        modulo: 'Fiscal', submodulo: 'FilaFaturamento',
        acao: 'ANOTAR', severidade: 'INFO',
        req, entidade: 'pedido', entidadeId: pedido,
        descricao: `Anotou pedido ${pedido} (Fila de Faturamento)`,
        meta: { pedido, acoes: acoes.slice(0, 200), observacoes: observacoes.slice(0, 200) }
      });

      return res.json({
        ok: true, pedido, acoes, observacoes,
        anotadoPor: nome, anotadoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('fiscal/fatura-anotacao:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// POST /financeiro/liberacao/anotacao
//
// Salva (upsert) as anotações de trabalho de um pedido na tela de Liberação
// Financeira: acoes e observacoes (ambos texto livre). 1 registro por pedido,
// compartilhado entre os operadores. Audita a alteração.
//
// Body: { pedido, acoes?, observacoes? }
//
// Permissão 8006.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006]);
const Auditoria = require('../../services/auditoria');

const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/liberacao/anotacao',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};

    const pedido = trim(b.pedido);
    if (!pedido) return res.status(400).json({ message: 'pedido é obrigatório.' });
    if (pedido.length > 10) return res.status(400).json({ message: 'pedido inválido.' });

    // acoes/observacoes: aceita string vazia (limpar). Limita tamanho defensivo.
    const acoes = trim(b.acoes).slice(0, 4000);
    const observacoes = trim(b.observacoes).slice(0, 4000);
    const nome = trim(user.NOME) || trim(user.EMAIL) || `id_${user.ID}`;

    try {
      await Pg.connectAndQuery(`
        INSERT INTO tab_lib_financeira_anotacao
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
        modulo: 'Financeiro', submodulo: 'LiberacaoFinanceira',
        acao: 'ANOTAR', severidade: 'INFO',
        req, entidade: 'pedido', entidadeId: pedido,
        descricao: `Anotou pedido ${pedido} (Liberação Financeira)`,
        meta: { pedido, acoes: acoes.slice(0, 200), observacoes: observacoes.slice(0, 200) }
      });

      return res.json({
        ok: true,
        pedido,
        acoes,
        observacoes,
        anotadoPor: nome,
        anotadoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('liberacao-anotacao:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

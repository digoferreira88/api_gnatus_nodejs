// GET /integracao/op-produtos — lista os produtos monitorados pela automacao
// OP -> Pipefy (modulo Planejamento). Permissao 3004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([3004]);
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/op-produtos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const rows = await Pg.connectAndQuery(
        `SELECT id, codigo, descricao, ativo, criado_nome, criado_em
           FROM tab_op_pipefy_produtos ORDER BY codigo`, {});
      return res.json({
        produtos: rows.map(r => ({
          id: r.id, codigo: trim(r.codigo), descricao: trim(r.descricao),
          ativo: !!r.ativo, criadoPor: trim(r.criado_nome), criadoEm: r.criado_em
        }))
      });
    } catch (err) {
      console.error('Erro op-produtos-list:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

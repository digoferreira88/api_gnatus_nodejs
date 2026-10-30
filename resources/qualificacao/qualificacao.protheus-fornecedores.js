// GET /qualificacao/protheus/fornecedores?q= — busca no cadastro de fornecedores do
// Protheus (SA2010, leitura) para cadastrar no módulo. Marca quem já está no módulo.
// Perm 23003+ (Engenharia).

const Q = require('../../services/qfCore');
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

module.exports = (app) => ({
  verb: 'get',
  route: '/protheus/fornecedores',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const q = Q.trim(req.query.q);
    if (q.length < 2) return res.json({ linhas: [] });
    try {
      let linhas;
      try { linhas = await Q.buscarSA2(Protheus, q); }
      catch (e) { if (ehConexao(e)) return res.status(503).json({ message: MSG_INDISPONIVEL, conexao: true }); throw e; }
      const codigos = linhas.map(l => l.codigo);
      const modulo = codigos.length ? await Pg.connectAndQuery(
        `SELECT id, codigo, status_qualificacao, criticidades, ativo FROM tab_qf_fornecedor WHERE codigo = ANY(@c)`, { c: codigos }) : [];
      const porCod = new Map(modulo.map(m => [m.codigo, m]));
      return res.json({ linhas: linhas.map(l => ({ ...l, modulo: porCod.get(l.codigo) || null })) });
    } catch (err) { return Q.falha(res, 'buscar fornecedores no Protheus', err); }
  }
});

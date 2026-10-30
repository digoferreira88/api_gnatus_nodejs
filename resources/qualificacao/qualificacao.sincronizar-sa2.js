// POST /qualificacao/fornecedores/sincronizar-sa2 — traz para o módulo os fornecedores do
// Protheus que ainda não estão nele (como não críticos: a FORM 7.3.24 sempre listou todo
// fornecedor do ERP) e atualiza nome/CNPJ/UF/país/bloqueio dos que já estão. Não mexe em
// criticidade, status nem SGQ. Perm 23003+ (Engenharia).

const Q = require('../../services/qfCore');
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

module.exports = (app) => ({
  verb: 'post',
  route: '/fornecedores/sincronizar-sa2',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    try {
      const r = await Q.sincronizarSA2(app, req);
      return res.json({ ok: true, ...r });
    } catch (err) {
      if (ehConexao(err)) return res.status(503).json({ message: MSG_INDISPONIVEL, conexao: true });
      return Q.falha(res, 'sincronizar com o Protheus', err);
    }
  }
});

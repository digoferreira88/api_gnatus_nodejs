// GET /qualificacao/config — configuração do módulo (destinatários, ações automáticas,
// envio ao fornecedor) e se o job diário de documentos está ligado. Perm 23004+.

const Q = require('../../services/qfCore');

module.exports = (app) => ({
  verb: 'get',
  route: '/config',
  middlewares: [Q.mw(app, 'qualidade')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const linhas = await Pg.connectAndQuery(
        `SELECT c.chave, c.valor, c.descricao, c.atualizado_em, u.nome AS atualizado_por_nome
           FROM tab_qf_config c LEFT JOIN tab_intranet_usr u ON u.id = c.atualizado_por ORDER BY c.chave`);
      return res.json({ linhas, jobDocumentosAtivo: String(process.env.QF_ALERTAS_ATIVO || '') === '1', ambiente: process.env.NODE_ENV || 'development' });
    } catch (err) { return Q.falha(res, 'carregar a configuração', err); }
  }
});

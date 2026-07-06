// GET /users/protheus-search?q=<texto> — busca usuários na SYS_USR do Protheus
// pra vincular o CODIGO PROTHEUS (USR_ID) na Gestão de Usuários. Perm 1028.
//
// Aceita nome, login (USR_CODIGO), USR_ID ou e-mail; devolve top 20 com flag de
// bloqueado (USR_MSBLQL='1'), ativos primeiro. Evita o descasamento clássico:
// admin digitava o código à mão e vinculava o USR_ID de OUTRA pessoa (caso
// Demer 000346 x 000041) -> aprovações de SC/PC falhavam com "login não
// encontrado na SAK/SAL".

const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1028]);

module.exports = app => ({
  verb: 'get',
  route: '/protheus-search',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);

    try {
      const rows = await Protheus.connectAndQuery(`
        SELECT TOP 20 RTRIM(USR_ID) usr_id, RTRIM(USR_CODIGO) login, RTRIM(USR_NOME) nome,
               RTRIM(USR_EMAIL) email, CASE WHEN USR_MSBLQL = @blq THEN 1 ELSE 0 END bloqueado
          FROM SYS_USR WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> @del
           AND (USR_ID LIKE @q OR UPPER(USR_CODIGO) LIKE @qU OR UPPER(USR_NOME) LIKE @qU OR UPPER(USR_EMAIL) LIKE @qU)
         ORDER BY CASE WHEN USR_MSBLQL = @blq THEN 1 ELSE 0 END, USR_NOME`,
        { del: '*', blq: '1', q: `%${q}%`, qU: `%${q.toUpperCase()}%` }
      );
      return res.json(rows);
    } catch (err) {
      if (ehConexao(err)) return res.status(503).json({ message: MSG_INDISPONIVEL, conexao: true });
      console.error('Erro users/protheus-search:', err.message);
      return res.status(500).json({ message: 'Erro ao consultar o Protheus.' });
    }
  }
});

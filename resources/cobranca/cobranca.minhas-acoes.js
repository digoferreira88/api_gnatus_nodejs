// Fila do analista logado: ações com promessa de pagamento ainda em aberto,
// ou ações recentes criadas pelo usuário. Permite acompanhar follow-ups.
const trim = (v) => String(v || '').trim();
const toNumber = (v) => Number(v || 0);

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002, 9003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/minhas-acoes',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const scope = String(req.query.scope || 'pendentes'); // pendentes | todas

    try {
      let sql = `
        SELECT a.ID, a.CLIENTE_COD, a.CLIENTE_LOJA,
               a.TIPO_ACAO, a.RESULTADO, a.DATA_PROMESSA, a.VALOR_PROMETIDO,
               a.DESCRICAO, a.CRIADO_EM, a.TITULO_NUM, a.TITULO_PARCELA
          FROM tab_cobranca_acao a
         WHERE a.ID_USER = @uid`;
      if (scope === 'pendentes') {
        sql += ` AND a.DATA_PROMESSA IS NOT NULL
                 AND a.RESULTADO IN ('PROMESSA_PAGAMENTO','ACORDO_FECHADO')`;
      }
      sql += ` ORDER BY COALESCE(a.DATA_PROMESSA, a.CRIADO_EM) ASC`;

      const rows = await Pg.connectAndQuery(sql, { uid: user.ID });
      if (!rows.length) return res.json({ acoes: [] });

      // Enriquece com nome do cliente via Protheus
      const clienteKeys = [...new Set(rows.map(r => `${trim(r.CLIENTE_COD)}|${trim(r.CLIENTE_LOJA)}`))];
      let clienteMap = new Map();
      try {
        const ors = clienteKeys.map((_, i) => `(A1_COD = @c${i} AND A1_LOJA = @l${i})`).join(' OR ');
        const params = {};
        clienteKeys.forEach((k, i) => {
          const [c, l] = k.split('|');
          params[`c${i}`] = c;
          params[`l${i}`] = l;
        });
        const sa1 = await Protheus.connectAndQuery(
          `SELECT RTRIM(A1_COD) cod, RTRIM(A1_LOJA) loja, RTRIM(A1_NOME) nome
             FROM SA1010 WITH (NOLOCK) WHERE D_E_L_E_T_ <> '*' AND (${ors})`, params
        );
        sa1.forEach(c => clienteMap.set(`${trim(c.cod)}|${trim(c.loja)}`, trim(c.nome)));
      } catch (e) { console.warn('minhas-acoes: falha ao buscar nomes de cliente.'); }

      const hoje = new Date(); hoje.setHours(0,0,0,0);

      const acoes = rows.map(r => {
        const key = `${trim(r.CLIENTE_COD)}|${trim(r.CLIENTE_LOJA)}`;
        const dp = r.DATA_PROMESSA ? new Date(r.DATA_PROMESSA) : null;
        let statusPromessa = null;
        if (dp) {
          const diff = Math.floor((dp - hoje) / (1000 * 60 * 60 * 24));
          if (diff < 0) statusPromessa = { codigo: 'ATRASADA', label: `${Math.abs(diff)}d atrasada`, cor: '#c9302c' };
          else if (diff === 0) statusPromessa = { codigo: 'HOJE', label: 'Vence hoje', cor: '#f5a500' };
          else if (diff <= 3) statusPromessa = { codigo: 'BREVE', label: `Em ${diff}d`, cor: '#5b9bd5' };
          else statusPromessa = { codigo: 'FUTURA', label: `Em ${diff}d`, cor: '#1e5fb5' };
        }
        return {
          id: r.ID,
          clienteCod: trim(r.CLIENTE_COD), clienteLoja: trim(r.CLIENTE_LOJA),
          clienteNome: clienteMap.get(key) || '(cliente não localizado)',
          tipoAcao: trim(r.TIPO_ACAO), resultado: trim(r.RESULTADO),
          dataPromessa: r.DATA_PROMESSA, valorPrometido: toNumber(r.VALOR_PROMETIDO),
          descricao: r.DESCRICAO || '', criadoEm: r.CRIADO_EM,
          tituloNum: trim(r.TITULO_NUM), tituloParcela: trim(r.TITULO_PARCELA),
          statusPromessa
        };
      });
      return res.json({ acoes });
    } catch (err) {
      console.error('Erro cobranca/minhas-acoes:', err);
      return res.status(500).json({ message: 'Erro ao consultar ações.' });
    }
  }
});

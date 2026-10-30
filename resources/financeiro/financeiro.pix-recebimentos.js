// GET /financeiro/pix-recebimentos — cobranças Pix dos títulos sem boleto.
//
// É a fila de baixa: o Pix cai, a conciliação casa pelo txid e o título fica
// aqui esperando alguém dar baixa no Protheus (FINA070). A baixa é humana por
// decisão do usuário — baixa financeira mexe em lançamento contábil, e o ERP
// tem rotina própria para isso.
//
// Filtros: ?estado=a_baixar|pagos|abertos|todos&de=&ate=&busca=
// Permissão 8009.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8009, 0]);

const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/pix-recebimentos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const estado = trim(req.query.estado) || 'a_baixar';
    const busca = trim(req.query.busca);
    const de = trim(req.query.de);
    const ate = trim(req.query.ate);

    const onde = ['1 = 1'];
    const params = {};

    if (estado === 'a_baixar') onde.push(`status = 'paga' AND baixado_em IS NULL`);
    else if (estado === 'pagos') onde.push(`status = 'paga'`);
    else if (estado === 'abertos') onde.push(`status IN ('criando', 'ativa')`);

    if (de) { onde.push(`criado_em >= @de::date`); params.de = de; }
    if (ate) { onde.push(`criado_em < (@ate::date + 1)`); params.ate = ate; }
    if (busca) {
      onde.push(`(numero ILIKE @busca OR cliente_nome ILIKE @busca OR cliente_doc ILIKE @busca
                  OR txid ILIKE @busca OR e2eid ILIKE @busca)`);
      params.busca = `%${busca}%`;
    }

    try {
      const linhas = await Pg.connectAndQuery(
        `SELECT c.id, c.txid, c.ref, c.status, c.cliente_doc, c.cliente_nome, c.cliente_cod, c.cliente_loja,
                c.prefixo, c.numero, c.parcela, c.valor_original, c.vencimento,
                c.multa_perc, c.juros_perc, c.expira_em,
                c.e2eid, c.valor_pago, c.pago_em, c.pagador_nome, c.pagador_doc,
                c.baixado_em, c.baixa_obs, u.nome AS baixado_nome,
                c.erro, c.criado_em
           FROM tab_pix_cobranca c
           LEFT JOIN tab_intranet_usr u ON u.id = c.baixado_por
          WHERE ${onde.join(' AND ')}
          ORDER BY COALESCE(c.pago_em, c.criado_em) DESC
          LIMIT 500`, params);

      // O resumo é o que o financeiro olha primeiro: quanto entrou e quanto
      // ainda não foi baixado.
      const resumo = await Pg.connectAndQuery(
        `SELECT
           count(*) FILTER (WHERE status = 'paga' AND baixado_em IS NULL) AS a_baixar,
           COALESCE(sum(valor_pago) FILTER (WHERE status = 'paga' AND baixado_em IS NULL), 0) AS valor_a_baixar,
           count(*) FILTER (WHERE status = 'paga' AND pago_em::date = CURRENT_DATE) AS pagos_hoje,
           COALESCE(sum(valor_pago) FILTER (WHERE status = 'paga' AND pago_em::date = CURRENT_DATE), 0) AS valor_hoje,
           count(*) FILTER (WHERE status IN ('criando','ativa')) AS abertos,
           count(*) FILTER (WHERE status = 'erro') AS com_erro
         FROM tab_pix_cobranca`, {});

      return res.json({ linhas, resumo: resumo[0] || {} });
    } catch (err) {
      console.error('financeiro/pix-recebimentos:', err.message);
      return res.status(500).json({ message: 'Erro ao carregar os recebimentos: ' + err.message });
    }
  }
});

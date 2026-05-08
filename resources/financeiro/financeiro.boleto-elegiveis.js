// GET /financeiro/boleto-elegiveis — titulos do SE1 elegiveis pra envio a banco.
// Filtros via query: busca, dataIni, dataFim, valorMin.
//
// Regra: saldo > 0, tipo NF (NF, NFS — exclui RA/NCC), portador vazio
// (ainda nao foi enviado) ou portador "carteira" (CP/RF), filial 01.
// Limite 1000 pra nao explodir.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/boleto-elegiveis',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const limit = Math.min(Math.max(Number(req.query.limit || 1000), 1), 5000);
    const params = { lim: limit };
    const conds = [];

    if (req.query.busca) {
      params.busca = String(req.query.busca).toUpperCase();
      conds.push(`AND (UPPER(sa1.A1_NOME) LIKE '%' + @busca + '%' OR RTRIM(se1.E1_CLIENTE) = @busca OR RTRIM(se1.E1_NUM) LIKE '%' + @busca + '%')`);
    }
    if (req.query.dataIni && /^\d{8}$/.test(String(req.query.dataIni))) {
      params.di = String(req.query.dataIni);
      conds.push(`AND se1.E1_VENCREA >= @di`);
    }
    if (req.query.dataFim && /^\d{8}$/.test(String(req.query.dataFim))) {
      params.df = String(req.query.dataFim);
      conds.push(`AND se1.E1_VENCREA <= @df`);
    }
    if (req.query.valorMin && Number(req.query.valorMin) > 0) {
      params.vmin = Number(req.query.valorMin);
      conds.push(`AND se1.E1_SALDO >= @vmin`);
    }

    const sql = `
      SELECT TOP ${limit}
        RTRIM(se1.E1_PREFIXO) prefixo,
        RTRIM(se1.E1_NUM)     numero,
        RTRIM(se1.E1_PARCELA) parcela,
        RTRIM(se1.E1_TIPO)    tipo,
        RTRIM(se1.E1_CLIENTE) clienteCod,
        RTRIM(se1.E1_LOJA)    clienteLoja,
        RTRIM(COALESCE(NULLIF(sa1.A1_NOME, ''), se1.E1_NOMCLI)) clienteNome,
        RTRIM(sa1.A1_CGC)     clienteCnpj,
        RTRIM(sa1.A1_EMAIL)   clienteEmail,
        RTRIM(sa1.A1_DDD)     clienteDdd,
        RTRIM(sa1.A1_TEL)     clienteTel,
        RTRIM(sa1.A1_EST)     clienteUf,
        se1.E1_EMISSAO        emissao,
        se1.E1_VENCREA        vencimento,
        se1.E1_VALOR          valor,
        se1.E1_SALDO          saldo,
        RTRIM(se1.E1_PORTADO) portador,
        RTRIM(se1.E1_NUMBOR)  bordero
      FROM SE1010 se1 WITH (NOLOCK)
      LEFT JOIN SA1010 sa1 WITH (NOLOCK)
        ON sa1.A1_COD = se1.E1_CLIENTE AND sa1.A1_LOJA = se1.E1_LOJA
       AND sa1.D_E_L_E_T_ <> '*'
      WHERE se1.D_E_L_E_T_ <> '*'
        AND se1.E1_FILIAL = '01'
        AND se1.E1_SALDO > 0
        AND RTRIM(se1.E1_TIPO) IN ('NF','NFS','BOL','DUP')
        AND (se1.E1_PORTADO IS NULL OR RTRIM(se1.E1_PORTADO) IN ('', 'CP', 'RF'))
        AND (se1.E1_NUMBOR IS NULL OR RTRIM(se1.E1_NUMBOR) = '')
        ${conds.join(' ')}
      ORDER BY se1.E1_VENCREA ASC, se1.E1_NUM
    `;

    try {
      const rows = await Protheus.connectAndQuery(sql, params);
      const titulos = rows.map(r => ({
        prefixo: trim(r.prefixo),
        numero: trim(r.numero),
        parcela: trim(r.parcela),
        tipo: trim(r.tipo),
        clienteCod: trim(r.clienteCod),
        clienteLoja: trim(r.clienteLoja),
        clienteNome: trim(r.clienteNome),
        clienteCnpj: trim(r.clienteCnpj),
        clienteEmail: trim(r.clienteEmail),
        clienteDdd: trim(r.clienteDdd),
        clienteTel: trim(r.clienteTel),
        clienteUf: trim(r.clienteUf),
        emissao: trim(r.emissao),
        vencimento: trim(r.vencimento),
        valor: toN(r.valor),
        saldo: toN(r.saldo),
        portador: trim(r.portador),
        bordero: trim(r.bordero)
      }));
      const totalSaldo = titulos.reduce((s, t) => s + t.saldo, 0);
      return res.json({
        titulos,
        total: titulos.length,
        totalSaldo: Number(totalSaldo.toFixed(2)),
        truncado: titulos.length === limit
      });
    } catch (err) {
      console.error('boleto-elegiveis:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

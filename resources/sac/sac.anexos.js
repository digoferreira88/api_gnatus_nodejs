// Lista anexos do banco de Conhecimento (TOTVS Documents) relacionados ao
// cliente. Busca em 2 fontes:
//   - SA1 (cadastro do cliente)         AC9_CODENT = '01' + cod + loja  (10 chars)
//   - SC5 (pedidos de venda do cliente) AC9_CODENT = numero do pedido    (6 chars)
//
// Retorna unificado, com origem ('Cadastro' ou 'Pedido NNNNNN') pra o
// usuario saber de onde veio cada documento.

const trim = (v) => String(v || '').trim();

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6001, 6002]);

module.exports = (app) => ({
  verb: 'get',
  route: '/anexos/:cod/:loja',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const cod  = trim(req.params.cod);
    const loja = trim(req.params.loja);
    if (!cod || !loja) return res.status(400).json({ message: 'cod e loja são obrigatórios.' });

    try {
      // 1) Anexos do cadastro (SA1) — formato observado: '01' + cod + loja (10 chars)
      const sqlSa1 = `
        SELECT DISTINCT
                RTRIM(ac9.AC9_CODOBJ) codObj,
                RTRIM(acb.ACB_OBJETO) nome,
                RTRIM(acb.ACB_DESCRI) descricao,
                'Cadastro do cliente' origem,
                acb.R_E_C_N_O_       recno
           FROM AC9010 ac9 WITH (NOLOCK)
           INNER JOIN ACB010 acb WITH (NOLOCK)
             ON acb.ACB_CODOBJ = ac9.AC9_CODOBJ AND acb.D_E_L_E_T_ <> '*'
          WHERE ac9.D_E_L_E_T_ <> '*'
            AND RTRIM(ac9.AC9_ENTIDA) = 'SA1'
            AND RTRIM(ac9.AC9_CODENT) IN (@cl, @clComFil)
      `;
      const sa1Rows = await Protheus.connectAndQuery(sqlSa1, {
        cl: cod + loja,
        clComFil: '01' + cod + loja
      });

      // 2) Anexos dos pedidos de venda do cliente (SC5)
      // Pega lista de pedidos do cliente nos ultimos 24 meses (limita o universo)
      const sqlPedidos = `
        SELECT DISTINCT TOP 500 RTRIM(C5_NUM) numero, MAX(C5_EMISSAO) emissao
          FROM SC5010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*'
           AND C5_FILIAL = '01'
           AND RTRIM(C5_CLIENTE) = @cod
           AND RTRIM(C5_LOJACLI) = @loja
         GROUP BY C5_NUM
         ORDER BY MAX(C5_EMISSAO) DESC
      `;
      const pedidos = await Protheus.connectAndQuery(sqlPedidos, { cod, loja });

      const sc5Rows = [];
      if (pedidos.length > 0) {
        // Batch de 500 por seguranca (limite mssql 2100 params)
        const BATCH = 500;
        for (let i = 0; i < pedidos.length; i += BATCH) {
          const slice = pedidos.slice(i, i + BATCH);
          const inP = slice.map((_, k) => `@p${k}`).join(',');
          const params = {};
          slice.forEach((p, k) => { params[`p${k}`] = trim(p.numero); });

          const r = await Protheus.connectAndQuery(`
            SELECT DISTINCT
                    RTRIM(ac9.AC9_CODOBJ) codObj,
                    RTRIM(acb.ACB_OBJETO) nome,
                    RTRIM(acb.ACB_DESCRI) descricao,
                    RTRIM(ac9.AC9_CODENT) pedidoNum,
                    acb.R_E_C_N_O_       recno
               FROM AC9010 ac9 WITH (NOLOCK)
               INNER JOIN ACB010 acb WITH (NOLOCK)
                 ON acb.ACB_CODOBJ = ac9.AC9_CODOBJ AND acb.D_E_L_E_T_ <> '*'
              WHERE ac9.D_E_L_E_T_ <> '*'
                AND RTRIM(ac9.AC9_ENTIDA) = 'SC5'
                AND RTRIM(ac9.AC9_CODENT) IN (${inP})
          `, params);

          r.forEach(x => sc5Rows.push({
            codObj: trim(x.codObj),
            nome: trim(x.nome),
            descricao: trim(x.descricao),
            origem: `Pedido ${trim(x.pedidoNum)}`,
            pedidoNum: trim(x.pedidoNum),
            recno: x.recno
          }));
        }
      }

      // Unifica + dedup por codObj (mesmo doc pode estar em vários pedidos)
      const todos = [
        ...sa1Rows.map(r => ({ codObj: trim(r.codObj), nome: trim(r.nome), descricao: trim(r.descricao), origem: r.origem, recno: r.recno })),
        ...sc5Rows
      ];
      const seen = new Set();
      const unicos = [];
      todos.forEach(a => {
        if (seen.has(a.codObj)) return;
        seen.add(a.codObj);
        unicos.push({ ...a, urlDownload: `/sac/anexo/${a.codObj}` });
      });
      // Ordena: cadastro primeiro, depois por nome
      unicos.sort((a, b) => {
        if (a.origem.startsWith('Cadastro') && !b.origem.startsWith('Cadastro')) return -1;
        if (!a.origem.startsWith('Cadastro') && b.origem.startsWith('Cadastro')) return 1;
        return (a.nome || '').localeCompare(b.nome || '');
      });

      return res.json({
        cliente: { cod, loja },
        totalCadastro: sa1Rows.length,
        totalPedidos: sc5Rows.length,
        totalPedidosAvaliados: pedidos.length,
        total: unicos.length,
        anexos: unicos
      });
    } catch (err) {
      console.error('Erro sac/anexos:', err);
      return res.status(500).json({ message: 'Erro ao listar anexos do cliente.' });
    }
  }
});

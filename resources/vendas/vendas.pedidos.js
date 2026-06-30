// GET /vendas/pedidos — lista pedidos de venda (SC5) com filtros para o
// "Espelho de Pedidos". Cabeçalho + total + status resumido. Somente leitura.
// Filtros: inicio/fim (C5_EMISSAO, obrigatórios), numero, cliente (cod ou nome),
// vendedor (cod ou nome). Perm 2006.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([2006, 0]);
const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const toProtheusDate = (iso) => {
  const s = String(iso || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};

function statusPedido(nota, blq, liberok) {
  if (trim(nota)) return { codigo: 'FATURADO', label: 'Faturado' };
  if (trim(blq) === '1') return { codigo: 'BLOQUEADO', label: 'Bloqueado' };
  if (trim(liberok) === 'S') return { codigo: 'LIBERADO', label: 'Liberado' };
  return { codigo: 'EM_ABERTO', label: 'Em aberto' };
}

module.exports = (app) => ({
  verb: 'get',
  route: '/pedidos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const inicio = toProtheusDate(req.query.inicio);
    const fim = toProtheusDate(req.query.fim);
    if (!inicio || !fim) return res.status(400).json({ message: 'Parâmetros inicio e fim são obrigatórios (YYYY-MM-DD).' });

    const params = { inicio, fim };
    const conds = [];
    const numero = trim(req.query.numero);
    if (numero) { params.num = numero.toUpperCase(); conds.push(`AND RTRIM(sc5.C5_NUM) LIKE '%' + @num + '%'`); }
    const cliente = trim(req.query.cliente);
    if (cliente) { params.cli = cliente; params.cliUp = cliente.toUpperCase(); conds.push(`AND (RTRIM(sc5.C5_CLIENTE) = @cli OR UPPER(sa1.A1_NOME) LIKE '%' + @cliUp + '%')`); }
    const vendedor = trim(req.query.vendedor);
    if (vendedor) { params.vend = vendedor; params.vendUp = vendedor.toUpperCase(); conds.push(`AND (RTRIM(sc5.C5_VEND1) = @vend OR UPPER(sa3.A3_NOME) LIKE '%' + @vendUp + '%')`); }

    const sql = `
      SELECT TOP 1000
        RTRIM(sc5.C5_NUM) numero, sc5.C5_EMISSAO emissao,
        RTRIM(sc5.C5_CLIENTE) clienteCod, RTRIM(sc5.C5_LOJACLI) clienteLoja, RTRIM(sa1.A1_NOME) clienteNome,
        RTRIM(sc5.C5_VEND1) vendCod, RTRIM(sa3.A3_NOME) vendNome,
        RTRIM(sc5.C5_CONDPAG) condPag, RTRIM(sc5.C5_ZTIPO) tipoCod, RTRIM(x5.X5_DESCRI) tipoNome,
        RTRIM(sc5.C5_NOTA) nota, RTRIM(sc5.C5_SERIE) serie, RTRIM(sc5.C5_BLQ) blq, RTRIM(sc5.C5_LIBEROK) liberok,
        ISNULL(it.total, 0) total, ISNULL(it.itens, 0) itens
      FROM SC5010 sc5 WITH (NOLOCK)
      LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD=sc5.C5_CLIENTE AND sa1.A1_LOJA=sc5.C5_LOJACLI AND sa1.D_E_L_E_T_<>'*'
      LEFT JOIN SA3010 sa3 WITH (NOLOCK) ON sa3.A3_COD=sc5.C5_VEND1 AND sa3.D_E_L_E_T_<>'*'
      LEFT JOIN SX5010 x5 WITH (NOLOCK) ON RTRIM(x5.X5_TABELA)='Z1' AND RTRIM(x5.X5_CHAVE)=RTRIM(sc5.C5_ZTIPO) AND x5.D_E_L_E_T_<>'*'
      LEFT JOIN (
        SELECT C6_FILIAL, C6_NUM, SUM(C6_VALOR) total, COUNT(*) itens
          FROM SC6010 WITH (NOLOCK) WHERE D_E_L_E_T_<>'*' GROUP BY C6_FILIAL, C6_NUM
      ) it ON it.C6_FILIAL=sc5.C5_FILIAL AND it.C6_NUM=sc5.C5_NUM
      WHERE sc5.C5_FILIAL='01' AND sc5.D_E_L_E_T_<>'*'
        AND sc5.C5_EMISSAO BETWEEN @inicio AND @fim
        ${conds.join(' ')}
      ORDER BY sc5.C5_EMISSAO DESC, sc5.C5_NUM DESC`;

    try {
      const rows = await Protheus.connectAndQuery(sql, params);
      const dados = rows.map(r => ({
        numero: trim(r.numero),
        emissao: trim(r.emissao),
        clienteCod: trim(r.clienteCod), clienteLoja: trim(r.clienteLoja), clienteNome: trim(r.clienteNome),
        vendCod: trim(r.vendCod), vendNome: trim(r.vendNome),
        condPag: trim(r.condPag), tipoCod: trim(r.tipoCod), tipoNome: trim(r.tipoNome) || trim(r.tipoCod),
        nota: trim(r.nota), serie: trim(r.serie),
        itens: N(r.itens), total: N(r.total),
        status: statusPedido(r.nota, r.blq, r.liberok)
      }));
      return res.json({
        periodo: { inicio, fim },
        totalRegistros: dados.length,
        limiteAtingido: dados.length >= 1000,
        geradoEm: new Date().toISOString(),
        dados
      });
    } catch (err) {
      console.error('Erro vendas/pedidos:', err);
      return res.status(500).json({ message: 'Erro ao listar pedidos de venda: ' + err.message });
    }
  }
});

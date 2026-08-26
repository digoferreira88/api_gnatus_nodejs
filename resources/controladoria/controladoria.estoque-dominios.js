// GET /controladoria/estoque-dominios
// Retorna listas pra popular dropdowns dos dashboards de estoque:
//   tipos    -> B1_TIPO distintos (do snapshot)
//   armazens -> NNR010 (codigo + descricao)
//   anosMes  -> YYYYMM disponiveis no snapshot (ordem desc)
//
// Permissao 11004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11004]);

const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/estoque-dominios',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;

    try {
      // Refresca o mês corrente (estoque de agora) antes de listar os domínios/filtros.
      try { await require('../../services/estoqueSnapshot').refrescarMesCorrente(app, { maxIdadeMin: 10 }); }
      catch (e) { console.warn('estoque-dominios: refresh mes corrente falhou:', e.message); }

      const [tipos, anosMes, armazens] = await Promise.all([
        Pg.connectAndQuery(`
          SELECT DISTINCT tipo_produto
            FROM tab_estoque_snapshot_mensal
           WHERE tipo_produto IS NOT NULL AND tipo_produto <> ''
           ORDER BY tipo_produto`, {}),
        Pg.connectAndQuery(`
          SELECT DISTINCT ano_mes
            FROM tab_estoque_snapshot_mensal
           ORDER BY ano_mes DESC
           LIMIT 24`, {}),
        Protheus.connectAndQuery(`
          SELECT RTRIM(NNR_CODIGO) codigo, RTRIM(NNR_DESCRI) descricao
            FROM NNR010 WITH (NOLOCK)
           WHERE D_E_L_E_T_ <> '*'
           ORDER BY NNR_CODIGO`, {})
      ]);

      return res.json({
        tipos: tipos.map(t => ({ codigo: trim(t.tipo_produto) })),
        armazens: armazens.map(a => ({ codigo: trim(a.codigo), descricao: trim(a.descricao) })),
        anosMes: anosMes.map(a => a.ano_mes)
      });
    } catch (err) {
      console.error('estoque-dominios:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

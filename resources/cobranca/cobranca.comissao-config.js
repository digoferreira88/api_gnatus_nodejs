// GET /cobranca/comissao/config — config da comissão (colaborador, faixas, BUs
// excluídas) + BUs disponíveis (live) + colaboradores p/ os selects. Perm 9005 (gestora).
const Comissao = require('../../services/cobrancaComissao');
const trim = (v) => String(v == null ? '' : v).trim();
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9005, 0]);

module.exports = (app) => ({
  verb: 'get',
  route: '/comissao/config',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;
    try {
      const cfg = await Comissao.carregarConfig(Pg);

      // Colaboradores (p/ escolher o cobrador)
      const usrs = await Pg.connectAndQuery(
        `SELECT id, nome FROM tab_intranet_usr ORDER BY nome`, {});
      const colaboradores = usrs.map(u => ({ id: u.id, nome: trim(u.nome) }));

      // BUs disponíveis: as que aparecem em boletos (emitidos nos últimos ~2 anos).
      let busDisponiveis = [];
      try {
        const buRows = await Protheus.connectAndQuery(`
          SELECT RTRIM(sc5.C5_ZTIPO) codigo, MAX(RTRIM(bu.X5_DESCRI)) label, COUNT(*) qtd
            FROM SE1010 se1 WITH (NOLOCK)
            LEFT JOIN SC5010 sc5 WITH (NOLOCK)
              ON sc5.C5_FILIAL = se1.E1_FILIAL AND sc5.C5_NUM = se1.E1_PEDIDO AND sc5.D_E_L_E_T_ <> '*'
            LEFT JOIN SX5010 bu WITH (NOLOCK)
              ON bu.X5_FILIAL = '  ' AND bu.X5_TABELA = 'Z1'
             AND RTRIM(bu.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND bu.D_E_L_E_T_ <> '*'
           WHERE se1.D_E_L_E_T_ <> '*' AND se1.E1_FILIAL = '01'
             AND RTRIM(se1.E1_FORMAPG) = '4' AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
             AND se1.E1_EMISSAO >= CONVERT(char(8), DATEADD(year, -2, GETDATE()), 112)
             AND RTRIM(sc5.C5_ZTIPO) <> ''
           GROUP BY RTRIM(sc5.C5_ZTIPO)
           ORDER BY MAX(RTRIM(bu.X5_DESCRI))`, {});
        busDisponiveis = buRows.map(b => ({
          codigo: trim(b.codigo), label: trim(b.label) || trim(b.codigo), qtd: Number(b.qtd || 0)
        }));
      } catch (e) { console.warn('comissao/config bus:', e.message); }

      return res.json({
        colaboradorId: cfg.colaboradorId,
        colaboradorNome: cfg.colaboradorNome,
        faixas: cfg.faixas,
        busExcluidas: cfg.busExcluidas,
        busDisponiveis,
        colaboradores
      });
    } catch (err) {
      console.error('cobranca/comissao-config:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// GET /gerencia/cc-busca?q= — autocomplete de centro de custo (CTT010) pra tela de
// Gestão de Usuários vincular CC ao gestor do DRE restrito. Não reusa
// /compras/centros-custo porque aquele exige perm 4004 (Compras) — quem administra
// usuários tem 1028, não necessariamente 4004.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1028]);
const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/cc-busca',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const q = trim(req.query.q);
    if (q.length < 2) return res.json({ ccs: [] });
    try {
      const rows = await Protheus.connectAndQuery(`
        SELECT TOP 30 RTRIM(CTT_CUSTO) codigo, RTRIM(CTT_DESC01) descricao
          FROM CTT010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*' AND CTT_BLOQ <> '1'
           AND CTT_FILIAL IN ('01', '  ', '')
           AND (RTRIM(CTT_CUSTO) LIKE @q + '%' OR UPPER(CTT_DESC01) LIKE '%' + UPPER(@q) + '%')
         ORDER BY CTT_CUSTO`, { q });
      return res.json({ ccs: rows.map(r => ({ codigo: trim(r.codigo), descricao: trim(r.descricao) })) });
    } catch (err) {
      console.error('gerencia/cc-busca:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

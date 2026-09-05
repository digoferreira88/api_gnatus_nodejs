// GET /ciosp/opcoes?edicao= — valores distintos p/ os selects da tela de
// lançamento (gerentes, vendedores, pagamentos, equipes, UFs...). Cresce sozinho
// conforme novos valores são digitados. Perm 19001.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19001, 0]);
const trim = (v) => String(v == null ? '' : v).trim();

// defaults sempre presentes (mesmo com a base vazia) — os mais usados na matriz
const DEF = {
  origem: ['Presencial', 'Online'],
  situacaoFin: ['Ok', 'Pendente'],
  pagtoPrinc: ['Cartão de Crédito', 'À vista', 'Unicred', 'Pré-Aprovado', 'Gnatus Cred', 'Omni', 'Cartão de Débito', 'Porto Bank', 'Pix'],
  categoria: ['EQUIPAMENTOS', 'DIGITAL', 'AT']
};

module.exports = (app) => ({
  verb: 'get',
  route: '/opcoes',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const edicao = trim(req.query.edicao);
    const cond = edicao ? 'WHERE edicao=@ed' : '';
    const p = edicao ? { ed: edicao } : {};

    const dist = async (col) => (await Pg.connectAndQuery(
      `SELECT DISTINCT ${col} v FROM tab_ciosp_venda ${cond} ${cond ? 'AND' : 'WHERE'} ${col} IS NOT NULL AND ${col} <> '' ORDER BY 1`, p))
      .map(r => trim(r.v)).filter(Boolean);

    const merge = (base, extra) => [...new Set([...base, ...extra])];

    try {
      const [gerentes, vendedores, pagto, equipes, ufs, financiadoras, edicoes] = await Promise.all([
        dist('gerente'), dist('vendedor'), dist('pagto_princ'), dist('equipe'), dist('uf'),
        dist('financiadora'),
        Pg.connectAndQuery(`SELECT DISTINCT edicao v FROM tab_ciosp_venda ORDER BY 1`, {}).then(r => r.map(x => x.v))
      ]);

      return res.json({
        gerentes, vendedores, equipes, ufs, financiadoras,
        pagtoPrinc: merge(DEF.pagtoPrinc, pagto),
        origem: DEF.origem, situacaoFin: DEF.situacaoFin, categoria: DEF.categoria,
        edicoes: edicoes.length ? edicoes : ['CIOSP 2026']
      });
    } catch (err) {
      console.error('ciosp/opcoes:', err.message);
      return res.status(500).json({ message: 'Erro ao carregar opções: ' + err.message });
    }
  }
});

// POST /universidade/rh/cargo/:codigo/trilhas — define quais trilhas o cargo recebe
// EM QUALQUER SETOR. Body: { trilhaIds: [1, 2] }. Recalcula os requisitos.
// (Para cargo só num setor, ou setor inteiro, use POST /rh/regras.) Perm 15004/15003.

const { ESCREVER, requirePerm, trim, usuario, audit, definirTrilhasDaChave } = require('./_rh');
const UniRh = require('../../services/universidadeRh');

module.exports = (app) => ({
  verb: 'post',
  route: '/rh/cargo/:codigo/trilhas',
  middlewares: [requirePerm(app, ESCREVER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const u = usuario(req);
    const codigo = trim(req.params.codigo);
    const ids = [...new Set((Array.isArray(req.body?.trilhaIds) ? req.body.trilhaIds : [])
      .map(Number).filter(n => Number.isInteger(n) && n > 0))];

    const cargo = await Pg.connectAndQuery(`SELECT codigo, descricao FROM tab_uni_cargo WHERE codigo = @c`, { c: codigo });
    if (!cargo.length) return res.status(404).json({ message: 'Cargo não encontrado (sincronize com o Protheus).' });

    await Pg.withTransaction(cli => definirTrilhasDaChave(cli, codigo, null, ids, u.ID));

    const requisitos = await UniRh.recalcularRequisitos(app);
    const nomes = await Pg.connectAndQuery(
      `SELECT string_agg(codigo, ', ' ORDER BY codigo) AS t FROM tab_uni_trilha WHERE id = ANY(@ids::int[])`, { ids });
    await audit(app, req, 'ALTERAR', 'uni_cargo', codigo,
      `Cargo ${codigo} (${cargo[0].descricao || ''}) em qualquer setor recebe as trilhas: ${nomes[0]?.t || 'nenhuma'}`, { trilhaIds: ids });

    return res.json({ ok: true, requisitos });
  }
});

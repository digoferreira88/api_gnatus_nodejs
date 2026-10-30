// POST /universidade/rh/cargo/:codigo/trilhas — define quais trilhas o cargo recebe.
// Body: { trilhaIds: [1, 2] }. Recalcula os requisitos. Perm 15004/15003.

const { ESCREVER, requirePerm, trim, usuario, audit } = require('./_rh');
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

    await Pg.withTransaction(async (cli) => {
      await cli.query(
        `DELETE FROM tab_uni_cargo_trilha WHERE cargo_codigo = $1 AND NOT (trilha_id = ANY($2::int[]))`, [codigo, ids]);
      if (ids.length) {
        await cli.query(`
          INSERT INTO tab_uni_cargo_trilha (cargo_codigo, trilha_id, criado_por)
          SELECT $1, t.id, $3 FROM tab_uni_trilha t WHERE t.id = ANY($2::int[])
          ON CONFLICT DO NOTHING`, [codigo, ids, u.ID || null]);
      }
    });

    const requisitos = await UniRh.recalcularRequisitos(app);
    const nomes = await Pg.connectAndQuery(
      `SELECT string_agg(codigo, ', ' ORDER BY codigo) AS t FROM tab_uni_trilha WHERE id = ANY(@ids::int[])`, { ids });
    await audit(app, req, 'ALTERAR', 'uni_cargo', codigo,
      `Cargo ${codigo} (${cargo[0].descricao || ''}) recebe as trilhas: ${nomes[0]?.t || 'nenhuma'}`, { trilhaIds: ids });

    return res.json({ ok: true, requisitos });
  }
});

// POST /universidade/rh/regras — define, de uma vez, quais trilhas valem para cada chave
// (cargo, setor). Usado na tabela "Cargos e setores": para um par cargo×setor o RH
// marca o que vale para o cargo em qualquer setor, só naquele setor, ou para o setor todo.
// Body: { chaves: [{ cargoCodigo|null, deptoCodigo|null, trilhaIds: [..] }, ...] }
// Cada chave tem o conjunto SUBSTITUÍDO. Recalcula os requisitos uma vez. Perm 15004/15003.

const { ESCREVER, requirePerm, trim, usuario, audit, validarRegras, definirTrilhasDaChave } = require('./_rh');
const UniRh = require('../../services/universidadeRh');

module.exports = (app) => ({
  verb: 'post',
  route: '/rh/regras',
  middlewares: [requirePerm(app, ESCREVER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const u = usuario(req);
    const chaves = (Array.isArray(req.body?.chaves) ? req.body.chaves : []).map(c => ({
      cargo: trim(c && c.cargoCodigo) || null,
      depto: trim(c && c.deptoCodigo) || null,
      trilhaIds: [...new Set((Array.isArray(c && c.trilhaIds) ? c.trilhaIds : []).map(Number).filter(n => Number.isInteger(n) && n > 0))]
    }));
    if (!chaves.length) return res.status(400).json({ message: 'Nada para salvar.' });
    if (chaves.some(c => !c.cargo && !c.depto)) return res.status(400).json({ message: 'Cada regra precisa de um cargo, um setor ou os dois.' });

    try {
      await Pg.withTransaction(async (cli) => {
        const erro = await validarRegras(cli, chaves);
        if (erro) { const e = new Error(erro); e.status = 400; throw e; }
        for (const c of chaves) await definirTrilhasDaChave(cli, c.cargo, c.depto, c.trilhaIds, u.ID);
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ message: err.message });
      throw err;
    }

    const requisitos = await UniRh.recalcularRequisitos(app);
    const desc = chaves.map(c => `${c.cargo ? `cargo ${c.cargo}` : 'qualquer cargo'} / ${c.depto ? `setor ${c.depto}` : 'qualquer setor'}: ${c.trilhaIds.length ? c.trilhaIds.join(',') : 'nenhuma'}`).join('; ');
    await audit(app, req, 'ALTERAR', 'uni_trilha_regra', null, `Trilhas por cargo/setor — ${desc}`, { chaves });
    return res.json({ ok: true, requisitos });
  }
});

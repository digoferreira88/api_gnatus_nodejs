// POST /universidade/rh/trilha — cria/edita uma trilha (Formação) com seus cursos e,
// opcionalmente, os cargos que a recebem. Recalcula os requisitos de todo mundo.
// Body: { id?, codigo, nome, descricao, aplicaTodos, ativo,
//         itens: [{ cursoId, ordem, obrigatorio, prazoDias, codigoExibicao }],
//         cargos?: ['00051', ...] }
// Perm 15004/15003.

const { ESCREVER, requirePerm, trim, txt, int, usuario, audit } = require('./_rh');
const UniRh = require('../../services/universidadeRh');

module.exports = (app) => ({
  verb: 'post',
  route: '/rh/trilha',
  middlewares: [requirePerm(app, ESCREVER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const u = usuario(req);
    const b = req.body || {};
    const id = int(b.id) || null;
    const codigo = trim(b.codigo).toUpperCase();
    const nome = txt(b.nome, 160);
    if (!/^[A-Z0-9][A-Z0-9.\-]{1,11}$/.test(codigo)) {
      return res.status(400).json({ message: 'Código da trilha: 2 a 12 caracteres (letras, números, ponto ou hífen). Ex.: INT, PRD, FRL.' });
    }
    if (!nome) return res.status(400).json({ message: 'Informe o nome da trilha.' });

    const itens = (Array.isArray(b.itens) ? b.itens : []).map((i, idx) => ({
      cursoId: int(i.cursoId),
      ordem: int(i.ordem) ?? idx + 1,
      obrigatorio: i.obrigatorio !== false,
      prazoDias: i.prazoDias === '' || i.prazoDias == null ? null : int(i.prazoDias),
      codigoExibicao: txt(i.codigoExibicao, 40)
    })).filter(i => i.cursoId);
    const ids = itens.map(i => i.cursoId);
    if (new Set(ids).size !== ids.length) return res.status(400).json({ message: 'O mesmo curso aparece duas vezes na trilha.' });
    if (itens.some(i => i.prazoDias != null && (i.prazoDias < 0 || i.prazoDias > 3650))) {
      return res.status(400).json({ message: 'Prazo deve ficar entre 0 e 3650 dias.' });
    }
    const cargos = Array.isArray(b.cargos) ? [...new Set(b.cargos.map(c => trim(c)).filter(Boolean))] : null;

    let trilhaId;
    try {
      trilhaId = await Pg.withTransaction(async (cli) => {
        let tid = id;
        if (tid) {
          const r = await cli.query(
            `UPDATE tab_uni_trilha SET codigo = $1, nome = $2, descricao = $3, aplica_todos = $4, ativo = $5, atualizado_em = NOW()
              WHERE id = $6 RETURNING id`,
            [codigo, nome, txt(b.descricao), !!b.aplicaTodos, b.ativo !== false, tid]);
          if (!r.rowCount) { const e = new Error('Trilha não encontrada.'); e.status = 404; throw e; }
        } else {
          const r = await cli.query(
            `INSERT INTO tab_uni_trilha (codigo, nome, descricao, aplica_todos, ativo, criado_por)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [codigo, nome, txt(b.descricao), !!b.aplicaTodos, b.ativo !== false, u.ID || null]);
          tid = r.rows[0].id;
        }

        if (ids.length) {
          const cur = await cli.query(`SELECT id FROM tab_uni_curso WHERE id = ANY($1::int[])`, [ids]);
          if (cur.rowCount !== ids.length) { const e = new Error('Curso inexistente na lista.'); e.status = 400; throw e; }
        }
        await cli.query(
          `DELETE FROM tab_uni_trilha_item WHERE trilha_id = $1 AND NOT (curso_id = ANY($2::int[]))`, [tid, ids]);
        for (const i of itens) {
          await cli.query(`
            INSERT INTO tab_uni_trilha_item (trilha_id, curso_id, ordem, obrigatorio, prazo_dias, codigo_exibicao)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (trilha_id, curso_id) DO UPDATE SET
              ordem = EXCLUDED.ordem, obrigatorio = EXCLUDED.obrigatorio,
              prazo_dias = EXCLUDED.prazo_dias, codigo_exibicao = EXCLUDED.codigo_exibicao`,
            [tid, i.cursoId, i.ordem, i.obrigatorio, i.prazoDias, i.codigoExibicao]);
        }

        if (cargos) {
          await cli.query(
            `DELETE FROM tab_uni_cargo_trilha WHERE trilha_id = $1 AND NOT (cargo_codigo = ANY($2::text[]))`, [tid, cargos]);
          if (cargos.length) {
            await cli.query(`
              INSERT INTO tab_uni_cargo_trilha (cargo_codigo, trilha_id, criado_por)
              SELECT g.codigo, $1, $3 FROM tab_uni_cargo g WHERE g.codigo = ANY($2::text[])
              ON CONFLICT DO NOTHING`, [tid, cargos, u.ID || null]);
          }
        }
        return tid;
      });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ message: `Já existe uma trilha com o código ${codigo}.` });
      if (err.status) return res.status(err.status).json({ message: err.message });
      throw err;
    }

    const requisitos = await UniRh.recalcularRequisitos(app);
    await audit(app, req, id ? 'ALTERAR' : 'CRIAR', 'uni_trilha', trilhaId,
      `${id ? 'Alterou' : 'Criou'} a trilha ${codigo} — ${nome} (${itens.length} curso(s)${cargos ? `, ${cargos.length} cargo(s)` : ''})`,
      { codigo, nome, aplicaTodos: !!b.aplicaTodos, ativo: b.ativo !== false, itens, cargos });

    return res.json({ ok: true, id: trilhaId, requisitos });
  }
});

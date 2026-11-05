// POST /universidade/rh/trilha — cria/edita uma trilha (Formação) com seus cursos e
// quem a recebe. Recalcula os requisitos de todo mundo.
// Body: { id?, codigo, nome, descricao, aplicaTodos, ativo,
//         itens: [{ cursoId, ordem, obrigatorio, prazoDias, codigoExibicao }],
//         regras?: [{ cargoCodigo|null, deptoCodigo|null }],   ← cargo e/ou setor (migration 141)
//         cargos?: ['00051', ...] }                            ← legado: = cargo em qualquer setor
// Sem regras/cargos no body, as regras da trilha não mudam.
// Perm 15004/15003.

const { ESCREVER, requirePerm, trim, txt, int, usuario, audit, normalizarRegras, validarRegras, gravarRegrasTrilha } = require('./_rh');
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

    let regras = null;
    if (Array.isArray(b.regras)) regras = normalizarRegras(b.regras);
    else if (Array.isArray(b.cargos)) regras = normalizarRegras(b.cargos.map(c => ({ cargoCodigo: c })));

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

        if (regras) {
          const erro = await validarRegras(cli, regras);
          if (erro) { const e = new Error(erro); e.status = 400; throw e; }
          await gravarRegrasTrilha(cli, tid, regras, u.ID);
        }
        return tid;
      });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ message: `Já existe uma trilha com o código ${codigo}.` });
      if (err.status) return res.status(err.status).json({ message: err.message });
      throw err;
    }

    const requisitos = await UniRh.recalcularRequisitos(app);
    const info = await Pg.connectAndQuery(`
      SELECT (SELECT count(DISTINCT colaborador_id) FROM vw_uni_colaborador_trilha WHERE trilha_id = @t)::int AS pessoas,
             (SELECT count(*) FROM tab_uni_trilha_item ti JOIN tab_uni_curso c ON c.id = ti.curso_id AND c.ativo
               WHERE ti.trilha_id = @t AND ti.obrigatorio)::int AS cursos_obrigatorios,
             (SELECT count(*) FROM tab_uni_trilha_regra WHERE trilha_id = @t)::int AS regras`, { t: trilhaId });

    await audit(app, req, id ? 'ALTERAR' : 'CRIAR', 'uni_trilha', trilhaId,
      `${id ? 'Alterou' : 'Criou'} a trilha ${codigo} — ${nome} (${itens.length} curso(s), ${info[0].regras} regra(s) de cargo/setor, ${info[0].pessoas} pessoa(s))`,
      { codigo, nome, aplicaTodos: !!b.aplicaTodos, ativo: b.ativo !== false, itens, regras });

    return res.json({
      ok: true, id: trilhaId, requisitos,
      pessoas: info[0].pessoas, cursosObrigatorios: info[0].cursos_obrigatorios, regras: info[0].regras
    });
  }
});

// POST /universidade/rh/versao/:id/publicar — publica um rascunho: vira a versão VIGENTE,
// a anterior vira OBSOLETA (não some). Se exige retreinamento, quem fez versão anterior
// passa a aparecer como DESATUALIZADO na conformidade.
// Body: { vigenteDesde? 'YYYY-MM-DD' } (padrão: hoje). Perm 15004/15003.

const { ESCREVER, requirePerm, dataISO, usuario, audit } = require('./_rh');
const UniRh = require('../../services/universidadeRh');

module.exports = (app) => ({
  verb: 'post',
  route: '/rh/versao/:id/publicar',
  middlewares: [requirePerm(app, ESCREVER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const u = usuario(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Versão inválida.' });
    const desde = dataISO(req.body?.vigenteDesde) || UniRh.hojeISO();

    let info;
    try {
      info = await Pg.withTransaction(async (cli) => {
        const v = await cli.query(
          `SELECT v.id, v.curso_id, v.revisao, v.status, v.exige_retreinamento, v.tipo, c.codigo
             FROM tab_uni_curso_versao v JOIN tab_uni_curso c ON c.id = v.curso_id
            WHERE v.id = $1 FOR UPDATE OF v`, [id]);
        if (!v.rowCount) { const e = new Error('Versão não encontrada.'); e.status = 404; throw e; }
        const ver = v.rows[0];
        if (ver.status !== 'rascunho') { const e = new Error(`A ${ver.revisao} já está ${ver.status}.`); e.status = 409; throw e; }

        const ant = await cli.query(
          `SELECT revisao, vigente_desde::text AS vd FROM tab_uni_curso_versao WHERE curso_id = $1 AND status = 'vigente'`, [ver.curso_id]);
        if (ant.rowCount && ant.rows[0].vd && desde < ant.rows[0].vd) {
          const e = new Error(`A data de vigência não pode ser anterior à da versão atual (${ant.rows[0].revisao}, ${ant.rows[0].vd}).`);
          e.status = 400; throw e;
        }
        await cli.query(
          `UPDATE tab_uni_curso_versao SET status = 'obsoleta', atualizado_em = NOW()
            WHERE curso_id = $1 AND status = 'vigente'`, [ver.curso_id]);
        await cli.query(
          `UPDATE tab_uni_curso_versao SET status = 'vigente', vigente_desde = $2, publicado_por = $3,
                  publicado_em = NOW(), atualizado_em = NOW()
            WHERE id = $1`, [id, desde, u.ID || null]);
        await cli.query(`UPDATE tab_uni_curso SET versao_atual_id = $1, atualizado_em = NOW() WHERE id = $2`, [id, ver.curso_id]);
        return { ...ver, anterior: ant.rows[0]?.revisao || null };
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ message: err.message });
      throw err;
    }

    const d = await Pg.connectAndQuery(`
      SELECT count(*)::int AS n FROM vw_uni_requisito_situacao s
        JOIN tab_uni_colaborador c ON c.id = s.colaborador_id AND c.ativo
       WHERE s.curso_id = @c AND s.ativo AND s.situacao = 'desatualizado'`, { c: info.curso_id });

    await audit(app, req, 'PUBLICAR', 'uni_curso_versao', id,
      `Publicou ${info.revisao} (${info.tipo}) do curso ${info.codigo}, vigente desde ${desde}` +
      (info.anterior ? `; ${info.anterior} ficou obsoleta` : '') +
      (info.exige_retreinamento ? `; exige retreinamento (${d[0].n} pessoa(s) desatualizada(s))` : ''),
      { vigenteDesde: desde, exigeRetreinamento: info.exige_retreinamento });

    return res.json({ ok: true, vigenteDesde: desde, anterior: info.anterior, desatualizados: d[0].n });
  }
});

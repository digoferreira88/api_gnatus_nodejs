// POST /tecnologia/acesso-tags — grava UMA posição do controle de acesso.
// Body: { posicao (1..1000), colaborador, setor, tag, obs }.
// colaborador vazio = LIBERA a posição (delete). Perm 1034. Auditado.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1034]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/acesso-tags',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};
    const posicao = Number(b.posicao);
    if (!Number.isInteger(posicao) || posicao < 1 || posicao > 1000) {
      return res.status(400).json({ message: 'posicao deve ser um inteiro entre 1 e 1000.' });
    }
    const colaborador = trim(b.colaborador).slice(0, 120);
    const setor = trim(b.setor).slice(0, 80);
    const tag = trim(b.tag).slice(0, 40);
    const obs = trim(b.obs).slice(0, 300) || null;
    const por = trim(user?.NOME) || null;

    try {
      if (!colaborador) {
        const del = await Pg.connectAndQuery(
          `DELETE FROM tab_acesso_tag WHERE posicao = @p RETURNING colaborador`, { p: posicao });
        Auditoria.registrar(app, {
          modulo: 'Tecnologia', submodulo: 'AcessoTags', acao: 'TAG_LIBERAR', severidade: 'INFO', req,
          entidade: 'acesso_tag', entidadeId: String(posicao),
          descricao: `Liberou a posição ${posicao}${del.length ? ` (era ${trim(del[0].colaborador)})` : ''}`
        });
        return res.json({ ok: true, liberada: true });
      }

      // Tag duplicada em outra posição é quase sempre erro de digitação — avisa
      // e bloqueia (o aparelho recusaria/confundiria o acesso).
      if (tag) {
        const dup = await Pg.connectAndQuery(
          `SELECT posicao, colaborador FROM tab_acesso_tag WHERE tag = @tag AND posicao <> @p LIMIT 1`,
          { tag, p: posicao });
        if (dup.length) {
          return res.status(409).json({
            message: `Tag ${tag} já está na posição ${dup[0].posicao} (${trim(dup[0].colaborador)}).`
          });
        }
      }

      await Pg.connectAndQuery(`
        INSERT INTO tab_acesso_tag (posicao, colaborador, setor, tag, obs, atualizado_por, atualizado_em)
        VALUES (@p, @colab, @setor, @tag, @obs, @por, NOW())
        ON CONFLICT (posicao)
        DO UPDATE SET colaborador = EXCLUDED.colaborador, setor = EXCLUDED.setor,
                      tag = EXCLUDED.tag, obs = EXCLUDED.obs,
                      atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()`,
        { p: posicao, colab: colaborador, setor, tag, obs, por });

      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'AcessoTags', acao: 'TAG_SALVAR', severidade: 'INFO', req,
        entidade: 'acesso_tag', entidadeId: String(posicao),
        descricao: `Posição ${posicao}: ${colaborador}${setor ? ` (${setor})` : ''} tag ${tag || '—'}`,
        meta: { posicao, colaborador, setor, tag }
      });
      return res.json({ ok: true, por, em: new Date().toISOString() });
    } catch (err) {
      console.error('tecnologia/acesso-tags-salvar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

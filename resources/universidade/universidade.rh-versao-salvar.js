// POST /universidade/rh/curso/:id/versao — cria uma nova revisão (rascunho) ou edita um
// rascunho existente. Versão publicada não se edita (trigger no banco): cria-se outra.
// Body: { id?, revisao, tipo (completa|adendo), exigeRetreinamento, resumoMudanca,
//         objetivos, conteudo, materiais, observacoes, duracaoMin, capacidade, professores,
//         documentoUrl, excluir? }   excluir=true remove um RASCUNHO.
// Perm 15004/15003.

const { ESCREVER, requirePerm, trim, txt, int, usuario, audit } = require('./_rh');

module.exports = (app) => ({
  verb: 'post',
  route: '/rh/curso/:id/versao',
  middlewares: [requirePerm(app, ESCREVER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const u = usuario(req);
    const cursoId = Number(req.params.id);
    const b = req.body || {};
    const vid = int(b.id) || null;
    if (!Number.isInteger(cursoId) || cursoId <= 0) return res.status(400).json({ message: 'Curso inválido.' });

    const curso = await Pg.connectAndQuery(`SELECT id, codigo FROM tab_uni_curso WHERE id = @id`, { id: cursoId });
    if (!curso.length) return res.status(404).json({ message: 'Curso não encontrado.' });

    if (vid) {
      const v = await Pg.connectAndQuery(
        `SELECT id, status, revisao FROM tab_uni_curso_versao WHERE id = @v AND curso_id = @c`, { v: vid, c: cursoId });
      if (!v.length) return res.status(404).json({ message: 'Versão não encontrada.' });
      if (v[0].status !== 'rascunho') {
        return res.status(409).json({ message: `A ${v[0].revisao} já foi publicada e não pode ser alterada. Crie uma nova revisão.` });
      }
      if (b.excluir === true) {
        await Pg.connectAndQuery(`DELETE FROM tab_uni_curso_versao WHERE id = @v AND status = 'rascunho'`, { v: vid });
        await audit(app, req, 'DELETE', 'uni_curso_versao', vid, `Excluiu o rascunho ${v[0].revisao} do curso ${curso[0].codigo}`);
        return res.json({ ok: true, excluida: true });
      }
    }

    const revisao = trim(b.revisao).toUpperCase();
    if (!/^R\d{4}$/.test(revisao)) return res.status(400).json({ message: 'Revisão no padrão R[AA][RR], ex.: R2600, R2601.' });
    const tipo = b.tipo === 'adendo' ? 'adendo' : 'completa';
    const urlDoc = txt(b.documentoUrl, 1000);
    if (urlDoc && !/^https?:\/\//i.test(urlDoc)) return res.status(400).json({ message: 'Link do documento deve começar com http(s)://' });

    const p = {
      revisao, tipo, exige: !!b.exigeRetreinamento, resumo: txt(b.resumoMudanca, 4000),
      objetivos: txt(b.objetivos, 20000), conteudo: txt(b.conteudo, 40000), materiais: txt(b.materiais, 8000),
      observacoes: txt(b.observacoes, 8000), duracao: int(b.duracaoMin), capacidade: int(b.capacidade),
      professores: txt(b.professores, 2000), url: urlDoc
    };

    let id = vid;
    try {
      if (vid) {
        await Pg.connectAndQuery(`
          UPDATE tab_uni_curso_versao SET revisao = @revisao, tipo = @tipo, exige_retreinamento = @exige,
                 resumo_mudanca = @resumo, objetivos = @objetivos, conteudo = @conteudo, materiais = @materiais,
                 observacoes = @observacoes, duracao_min = @duracao, capacidade = @capacidade,
                 professores = @professores, documento_url = @url, atualizado_em = NOW()
           WHERE id = @id AND status = 'rascunho'`, { ...p, id: vid });
      } else {
        const r = await Pg.connectAndQuery(`
          INSERT INTO tab_uni_curso_versao (curso_id, revisao, tipo, status, exige_retreinamento, resumo_mudanca,
                 objetivos, conteudo, materiais, observacoes, duracao_min, capacidade, professores, documento_url, criado_por)
          VALUES (@curso, @revisao, @tipo, 'rascunho', @exige, @resumo, @objetivos, @conteudo, @materiais,
                  @observacoes, @duracao, @capacidade, @professores, @url, @uid)
          RETURNING id`, { ...p, curso: cursoId, uid: u.ID || null });
        id = r[0].id;
      }
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ message: `O curso já tem a revisão ${revisao}.` });
      throw err;
    }

    await audit(app, req, vid ? 'ALTERAR' : 'CRIAR', 'uni_curso_versao', id,
      `${vid ? 'Alterou' : 'Criou'} o rascunho ${revisao} (${tipo}) do curso ${curso[0].codigo}`, p);
    return res.json({ ok: true, id });
  }
});

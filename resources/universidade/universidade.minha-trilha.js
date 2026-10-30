// GET /universidade/minha-trilha — os treinamentos exigidos para o usuário logado
// (pelo cargo no Protheus), a situação de cada um, onde fazer (curso EAD ou turma
// aberta) e o histórico. Qualquer usuário autenticado; acha o colaborador pelo
// vínculo da sincronização ou pelo e-mail.

const { usuario } = require('./_rh');
const { fichaColaborador } = require('./universidade.rh-colaborador');

module.exports = (app) => ({
  verb: 'get',
  route: '/minha-trilha',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const u = usuario(req);
    if (!u.ID) return res.status(401).json({ message: 'Não autenticado.' });

    const c = await Pg.connectAndQuery(`
      SELECT c.id FROM tab_uni_colaborador c
       WHERE c.user_id = @uid
          OR (COALESCE(c.email, '') <> '' AND lower(c.email) = lower(@email))
       ORDER BY (c.user_id = @uid) DESC NULLS LAST, c.ativo DESC
       LIMIT 1`, { uid: u.ID, email: String(u.EMAIL || u.email || '') });
    if (!c.length) return res.json({ encontrado: false });

    const ficha = await fichaColaborador(Pg, c[0].id);
    const cursoIds = [...new Set(ficha.requisitos.map(r => r.cursoId))];

    // Onde fazer: turmas publicadas com data futura vinculadas ao curso, e se há EAD.
    const [turmas, ead] = cursoIds.length ? await Promise.all([
      Pg.connectAndQuery(`
        SELECT t.id, t.titulo, t.curso_id, t.modalidades,
               (SELECT min(s.data) FROM tab_treina_sessao s
                 WHERE s.treinamento_id = t.id AND s.status = 'agendada' AND s.data >= CURRENT_DATE)::text AS proxima_data
          FROM tab_treina_treinamento t
         WHERE t.curso_id = ANY(@ids::int[]) AND t.status = 'publicado'
           AND EXISTS (SELECT 1 FROM tab_treina_sessao s WHERE s.treinamento_id = t.id AND s.status = 'agendada' AND s.data >= CURRENT_DATE)`,
        { ids: cursoIds }),
      Pg.connectAndQuery(`
        SELECT cu.id FROM tab_uni_curso cu
         WHERE cu.id = ANY(@ids::int[]) AND cu.ativo AND cu.publico
           AND EXISTS (SELECT 1 FROM tab_uni_aula a WHERE a.curso_id = cu.id)`, { ids: cursoIds })
    ]) : [[], []];
    const eadSet = new Set(ead.map(e => e.id));

    // Não expõe CPF nem dados de folha p/ o próprio colaborador além do necessário.
    const { cpf, centroCusto, situacaoFolha, sincronizadoEm, ...colab } = ficha.colaborador;
    return res.json({
      encontrado: true,
      colaborador: colab,
      trilhas: ficha.trilhas,
      requisitos: ficha.requisitos.map(r => ({
        ...r,
        temEad: eadSet.has(r.cursoId),
        turmas: turmas.filter(t => t.curso_id === r.cursoId)
          .map(t => ({ id: t.id, titulo: t.titulo, modalidades: t.modalidades, proximaData: t.proxima_data }))
      })),
      evidencias: ficha.evidencias.map(({ loteId, registroId, temAnexo, ...e }) => e)
    });
  }
});

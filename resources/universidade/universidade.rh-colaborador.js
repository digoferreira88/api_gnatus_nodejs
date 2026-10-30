// GET /universidade/rh/colaborador/:id — ficha de treinamento do colaborador:
// dados do Protheus, movimentações (admissão/mudança de cargo), trilhas que se aplicam,
// requisitos com situação e TODAS as evidências (inclusive de cursos não exigidos).
// Perm 15004/15005/15003.

const { LER, requirePerm, camel } = require('./_rh');

async function fichaColaborador(Pg, id) {
  const col = await Pg.connectAndQuery(`
    SELECT c.id, c.nome, c.cpf, c.filial, c.matricula, c.email, c.cargo_codigo, c.cargo_desc,
           c.funcao_codigo, c.funcao_desc, c.depto_desc, c.centro_custo,
           c.admissao::text AS admissao, c.demissao::text AS demissao, c.cargo_desde::text AS cargo_desde,
           c.ativo, c.situacao AS situacao_folha, (c.user_id IS NOT NULL) AS tem_login, c.sincronizado_em
      FROM tab_uni_colaborador c WHERE c.id = @id`, { id });
  if (!col.length) return null;
  const c = col[0];

  const [eventos, trilhas, requisitos, evidencias, anulados] = await Promise.all([
    Pg.connectAndQuery(`
      SELECT id, tipo, de, para, data::text AS data, registrado_em
        FROM tab_uni_colaborador_evento WHERE colaborador_id = @id ORDER BY registrado_em DESC, id DESC`, { id }),
    Pg.connectAndQuery(`
      SELECT t.id, t.codigo, t.nome, t.aplica_todos
        FROM tab_uni_trilha t
       WHERE t.ativo AND t.publico = 'interno'
         AND (t.aplica_todos OR EXISTS (SELECT 1 FROM tab_uni_cargo_trilha ct
                                         WHERE ct.trilha_id = t.id AND ct.cargo_codigo = @cargo))
       ORDER BY t.aplica_todos DESC, t.codigo`, { cargo: c.cargo_codigo || '' }),
    Pg.connectAndQuery(`
      SELECT s.id, s.curso_id, cu.codigo AS curso_codigo, cu.titulo AS curso_titulo, cu.formato,
             cu.validade_meses, a.codigo AS area,
             s.obrigatorio, s.origem, s.desde::text AS desde, s.prazo_dias, s.prazo::text AS prazo,
             s.situacao, s.evidencia_ref, s.evidencia_fonte, s.evidencia_data::text AS evidencia_data,
             s.evidencia_revisao, s.revisao_minima, s.valido_ate::text AS valido_ate,
             s.dispensado, s.dispensa_motivo, s.dispensado_em, s.ativo,
             (SELECT count(*) FROM tab_uni_aula au WHERE au.curso_id = cu.id)::int AS qtd_aulas
        FROM vw_uni_requisito_situacao s
        JOIN tab_uni_curso cu ON cu.id = s.curso_id
        LEFT JOIN tab_uni_area a ON a.id = cu.area_id
       WHERE s.colaborador_id = @id AND s.ativo
       ORDER BY CASE s.situacao WHEN 'atrasado' THEN 0 WHEN 'vencido' THEN 1 WHEN 'desatualizado' THEN 2
                                WHEN 'pendente' THEN 3 WHEN 'a_vencer' THEN 4 ELSE 5 END, cu.titulo`, { id }),
    Pg.connectAndQuery(`
      SELECT e.ref, e.fonte, e.curso_id, cu.codigo AS curso_codigo, cu.titulo AS curso_titulo,
             e.data::text AS data, e.modalidade, e.carga_h, e.instrutor, e.origem, e.aprovado, e.nota,
             e.lote_id, e.registro_id, e.detalhe, v.revisao,
             (l.anexo_path IS NOT NULL) AS tem_anexo
        FROM vw_uni_evidencia e
        JOIN tab_uni_curso cu ON cu.id = e.curso_id
        LEFT JOIN tab_uni_curso_versao v ON v.id = e.versao_id
        LEFT JOIN tab_uni_registro_lote l ON l.id = e.lote_id
       WHERE e.colaborador_id = @id
       ORDER BY e.data DESC NULLS LAST, e.ref`, { id }),
    Pg.connectAndQuery(`
      SELECT r.id, cu.codigo AS curso_codigo, cu.titulo AS curso_titulo, r.data_realizacao::text AS data,
             r.anulado_motivo, r.anulado_em, u.nome AS anulado_por
        FROM tab_uni_registro r
        JOIN tab_uni_curso cu ON cu.id = r.curso_id
        LEFT JOIN tab_intranet_usr u ON u.id = r.anulado_por
       WHERE r.colaborador_id = @id AND r.anulado
       ORDER BY r.anulado_em DESC`, { id })
  ]);

  return {
    colaborador: camel(c),
    eventos: eventos.map(camel),
    trilhas: trilhas.map(camel),
    requisitos: requisitos.map(camel),
    evidencias: evidencias.map(camel),
    anulados: anulados.map(camel)
  };
}

module.exports = (app) => ({
  verb: 'get',
  route: '/rh/colaborador/:id',
  middlewares: [requirePerm(app, LER)],

  handler: async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'ID inválido.' });
    const ficha = await fichaColaborador(app.services.Pg, id);
    if (!ficha) return res.status(404).json({ message: 'Colaborador não encontrado.' });
    return res.json(ficha);
  }
});

module.exports.fichaColaborador = fichaColaborador;

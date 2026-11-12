// GET /universidade/gestor/equipe?setor=<codigo> — painel do gestor: os colaboradores dos
// setores dele (responsável no Protheus + setores abaixo), com o placar dos treinamentos,
// pendências e reprovações. Qualquer usuário autenticado; quem não é gestor recebe gestor:false.

const { usuario, trim, camel, colaboradorDoUsuario, setoresDoGestor, consultaColaboradores, indicadorReprovacoes } = require('./_rh');

module.exports = (app) => ({
  verb: 'get',
  route: '/gestor/equipe',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const col = await colaboradorDoUsuario(Pg, usuario(req));
    if (!col || !col.ativo) return res.json({ gestor: false });
    const setores = await setoresDoGestor(Pg, col.cpf);
    if (!setores.length) return res.json({ gestor: false });

    const filtro = trim(req.query.setor);
    const todos = setores.map(s => s.codigo);
    const deptos = filtro && todos.includes(filtro) ? [filtro] : todos;

    const [colaboradores, reprov, pendencias] = await Promise.all([
      consultaColaboradores(Pg, { deptos, excluirId: col.id }),
      indicadorReprovacoes(Pg, { deptos }),
      Pg.connectAndQuery(`
        SELECT s.id, s.situacao, s.prazo::text AS prazo, c.id AS colaborador_id, c.nome, c.depto_desc,
               cu.id AS curso_id, cu.codigo AS curso_codigo, cu.titulo AS curso_titulo
          FROM vw_uni_requisito_situacao s
          JOIN tab_uni_colaborador c ON c.id = s.colaborador_id AND c.ativo
          JOIN tab_uni_curso cu      ON cu.id = s.curso_id
         WHERE s.ativo AND s.obrigatorio AND c.depto_codigo = ANY(@deptos::text[]) AND c.id <> @eu
           AND s.situacao IN ('atrasado','vencido','desatualizado','pendente','a_vencer')
         ORDER BY CASE s.situacao WHEN 'atrasado' THEN 0 WHEN 'vencido' THEN 1 WHEN 'desatualizado' THEN 2
                                  WHEN 'pendente' THEN 3 ELSE 4 END, s.prazo NULLS LAST, c.nome
         LIMIT 400`, { deptos, eu: col.id })
    ]);

    const k = { pessoas: colaboradores.length, em_dia: 0, pendente: 0, irregular: 0, sem_trilha: 0 };
    let req_total = 0; let req_ok = 0;
    colaboradores.forEach(c => {
      k[c.situacaoGeral] = (k[c.situacaoGeral] || 0) + 1;
      req_total += c.total;
      req_ok += c.emDia + c.aVencer + c.dispensado;
    });

    return res.json({
      gestor: true,
      setores: setores.map(s => ({ codigo: s.codigo, descricao: s.descricao, nivel: s.nivel, pessoas: s.pessoas })),
      setorFiltro: deptos.length === 1 && filtro ? filtro : null,
      kpis: {
        pessoas: k.pessoas, emDia: k.em_dia, noPrazo: k.pendente, irregulares: k.irregular, nadaExigido: k.sem_trilha,
        requisitos: req_total, conformes: req_ok,
        percentualConformidade: req_total ? Math.round((req_ok / req_total) * 1000) / 10 : null,
        reprovacoes: reprov.resumo.reprovacoes
      },
      colaboradores,
      pendencias: pendencias.map(camel),
      reprovacoes: reprov
    });
  }
});

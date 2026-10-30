// GET /qualificacao/inspecoes/:id — um relatório de inspeção com anexos, regra usada,
// as entregas que formaram o índice N e a trilha de alterações. Perm 23001+.

const Q = require('../../services/qfCore');

module.exports = (app) => ({
  verb: 'get',
  route: '/inspecoes/:id',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'id inválido.' });
    try {
      const [i] = await Pg.connectAndQuery(
        `SELECT i.*, r.nome AS regra_nome, uc.nome AS criado_por_nome, ua.nome AS atualizado_por_nome, ux.nome AS excluido_por_nome,
                f.status_qualificacao AS fornecedor_status, f.classificacao AS fornecedor_classe, f.iqf_medio AS fornecedor_iqf
           FROM tab_qf_inspecao i
           JOIN tab_qf_fornecedor f ON f.id = i.fornecedor_id
           LEFT JOIN tab_qf_regra_versao r ON r.id = i.regra_versao_id
           LEFT JOIN tab_intranet_usr uc ON uc.id = i.criado_por
           LEFT JOIN tab_intranet_usr ua ON ua.id = i.atualizado_por
           LEFT JOIN tab_intranet_usr ux ON ux.id = i.excluido_por
          WHERE i.id = @id`, { id });
      if (!i) return res.status(404).json({ message: 'Inspeção não encontrada.' });
      const anexos = await Pg.connectAndQuery(
        `SELECT a.id, a.categoria, a.nome_arquivo, a.mime_type, a.tamanho_bytes, a.descricao, a.enviado_em, a.enviado_por, u.nome AS enviado_por_nome
           FROM tab_qf_anexo a LEFT JOIN tab_intranet_usr u ON u.id = a.enviado_por
          WHERE a.entidade = 'inspecao' AND a.entidade_id = @id AND NOT a.excluido ORDER BY a.enviado_em`, { id });
      const log = await Pg.connectAndQuery(
        `SELECT acao, campo, valor_anterior, valor_novo, motivo, usuario_nome, criado_em FROM tab_qf_log
          WHERE entidade = 'inspecao' AND entidade_id = @id ORDER BY criado_em DESC, id DESC`, { id });
      const janela = i.data_inspecao ? await Q.ncsAnteriores(Pg, (await Q.regraAtiva(Pg)).conteudo, {
        fornecedorId: i.fornecedor_id, codItem: i.cod_item, dataInspecao: i.data_inspecao, relInsp: i.rel_insp, excluirId: i.id
      }) : { entregas: [] };
      return res.json({
        inspecao: i, anexos, log,
        janelaN: janela.entregas.map(e => ({ id: e.id, relInsp: e.rel_insp, data: e.data_inspecao, nc: e.nc, codItem: e.cod_item })),
        niveis: await Q.niveisDoUsuario(Pg, req)
      });
    } catch (err) { return Q.falha(res, 'carregar a inspeção', err); }
  }
});

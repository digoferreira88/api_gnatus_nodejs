// GET /contratos/:id — contrato + aditivos + anexos (sem conteudo binario)
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5002]);
const Contratos = require('../../services/contratos');

module.exports = (app) => ({
  verb: 'get',
  route: '/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });
    try {
      const rows = await Pg.connectAndQuery(`
        SELECT c.*, u.nome AS responsavel_nome_user,
               cri.nome AS criado_por_nome,
               atu.nome AS atualizado_por_nome
          FROM tab_contrato c
          LEFT JOIN tab_intranet_usr u   ON u.id   = c.id_user_responsavel
          LEFT JOIN tab_intranet_usr cri ON cri.id = c.id_user_criou
          LEFT JOIN tab_intranet_usr atu ON atu.id = c.id_user_atualizou
         WHERE c.id = @id`, { id });
      if (!rows.length) return res.status(404).json({ message: 'Contrato nao encontrado.' });

      const aditivos = await Pg.connectAndQuery(
        `SELECT a.*, u.nome AS aprovador_nome FROM tab_contrato_aditivo a
         LEFT JOIN tab_intranet_usr u ON u.id = a.id_user_aprovador
         WHERE a.id_contrato = @id ORDER BY a.criado_em DESC`, { id });

      // Anexos sem o bytea (carregado sob demanda no download)
      const anexos = await Pg.connectAndQuery(`
        SELECT id, nome_arquivo, mime_type, tamanho_bytes, descricao, criado_em,
               (SELECT nome FROM tab_intranet_usr WHERE id = tab_contrato_anexo.id_user) AS enviado_por
          FROM tab_contrato_anexo
         WHERE id_contrato = @id ORDER BY criado_em DESC`, { id });

      return res.json({
        contrato: Contratos.enriquecer(rows[0]),
        aditivos,
        anexos
      });
    } catch (err) {
      console.error('contratos/detail:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// GET /producao/instrucoes/produto/:codigo
// Devolve as instrucoes cadastradas pra um produto, agrupadas por etapa.
// Usado pela pagina de cadastro (mostra cobertura) E pelo registro
// (carrega ao abrir uma OP do produto).
//
// Permissao: 14001/14002/14003 — qualquer um do modulo de Producao.
// (Operador precisa enxergar pra consultar instrucao na execucao.)

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([14001, 14002, 14003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/instrucoes/produto/:codigo',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const codigo = String(req.params.codigo || '').trim();
    if (!codigo) return res.status(400).json({ message: 'codigo obrigatorio.' });

    try {
      const rows = await Pg.connectAndQuery(`
        SELECT i.id, i.produto_codigo, i.etapa_codigo, i.titulo, i.web_url,
               i.sharepoint_drive_id, i.sharepoint_item_id, i.sharepoint_path,
               i.nome_original, i.mime_type, i.tamanho_bytes,
               i.criado_em, i.atualizado_em,
               u1.nome AS criado_por_nome,
               u2.nome AS atualizado_por_nome
          FROM tab_prod_instrucao i
          LEFT JOIN tab_intranet_usr u1 ON u1.id = i.criado_por
          LEFT JOIN tab_intranet_usr u2 ON u2.id = i.atualizado_por
         WHERE i.produto_codigo = @cod
         ORDER BY i.etapa_codigo NULLS FIRST`,
        { cod: codigo }
      );

      // Busca descricao do produto no Protheus (opcional — facilita UI)
      let descricao = null;
      try {
        const d = await Protheus.connectAndQuery(
          `SELECT TOP 1 RTRIM(B1_DESC) AS descricao FROM SB1010 WITH (NOLOCK) WHERE RTRIM(B1_COD) = @cod AND D_E_L_E_T_ <> '*'`,
          { cod: codigo }
        );
        descricao = d[0]?.descricao || null;
      } catch { /* protheus offline nao bloqueia */ }

      return res.json({
        produto_codigo: codigo,
        descricao,
        instrucoes: rows
      });
    } catch (err) {
      console.error('producao/instrucoes-produto:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

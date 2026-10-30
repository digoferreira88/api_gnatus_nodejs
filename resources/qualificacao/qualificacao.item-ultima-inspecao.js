// GET /qualificacao/inspecoes/ultima-do-item?cod= — última inspeção do item (para
// repetir ESP., critério de aceitação, instrumento e nível quando não há pedido em mãos).
// O código é comparado sem zeros à esquerda: a planilha gravava "12614", o Protheus "012614".
// Perm 23002+.

const Q = require('../../services/qfCore');

module.exports = (app) => ({
  verb: 'get',
  route: '/inspecoes/ultima-do-item',
  middlewares: [Q.mw(app, 'inspetor')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const cod = Q.trim(req.query.cod);
    if (!cod) return res.json({ inspecao: null });
    try {
      const [i] = await Pg.connectAndQuery(
        `SELECT id, rel_insp, data_inspecao, fornecedor_codigo, fornecedor_nome, nivel_inspecao, especificacao, criterio_aceitacao,
                instrumento_utilizado, resultado_descricao, descricao_item, iqf, nc
           FROM tab_qf_inspecao WHERE NOT excluido AND LTRIM(cod_item, '0') = LTRIM(@c, '0')
          ORDER BY data_inspecao DESC NULLS LAST, rel_insp DESC LIMIT 1`, { c: cod });
      return res.json({ inspecao: i || null });
    } catch (err) { return Q.falha(res, 'buscar a última inspeção do item', err); }
  }
});

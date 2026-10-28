// GET /financeiro/boleto-pdf/:id
//
// Gera o PDF do boleto no layout Febraban 102 (recibo do pagador + ficha de
// compensacao + codigo de barras Interleaved 2 of 5). Mesmos dados que o
// boleto-disparar usa pra montar o e-mail, mas renderizados como PDF.
//
//   :id = tab_boleto_envio_lote_retorno.id (do titulo REGISTRADO no banco)
//
// A montagem vive em services/boletoDocumento.js porque o portal do cliente
// publica o MESMO PDF no espelho. Aqui so sobra o HTTP.
//
// Resposta: application/pdf (inline; usuario salva ou imprime no browser).
// Em caso de erro, devolve JSON 4xx/5xx.
//
// Permissao 8005 (mesma de Envio de Boleto).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const BoletoDocumento = require('../../services/boletoDocumento');

module.exports = (app) => ({
  verb: 'get',
  route: '/boleto-pdf/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    try {
      const r = await BoletoDocumento.gerar(app, req.params.id);
      if (!r.ok) return res.status(r.status).json(r.body);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${r.filename}"`);
      res.setHeader('Content-Length', String(r.pdf.length));
      return res.end(r.pdf);
    } catch (err) {
      console.error('boleto-pdf:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// POST /eyemobile/precos-preview — calcula o que mudaria nos cardápios (49456 e
// 54643 +3%) a partir da planilha do comercial (aba Geral). NÃO escreve nada.
// Body: { itens: [{ codigo, valor, descricao }] }. Perm 16100.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16100, 0]);
const Eye = require('../../services/eyemobile');

module.exports = (app) => ({
  verb: 'post',
  route: '/precos-preview',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    if (!Eye.disponivel()) return res.status(503).json({ message: 'Integração EyeMobile não configurada (chaves ausentes).' });
    const itens = (req.body && req.body.itens) || [];
    if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ message: 'Envie os itens da planilha (aba Geral): [{codigo, valor, descricao}].' });
    try {
      const [alteracoes, cadastros] = await Promise.all([Eye.calcularAlteracoes(itens), Eye.calcularCadastros(itens)]);
      return res.json({ ...alteracoes, cadastros });
    } catch (err) {
      console.error('eyemobile/precos-preview:', err.message);
      return res.status(502).json({ message: 'Erro ao consultar a EyeMobile: ' + err.message });
    }
  }
});

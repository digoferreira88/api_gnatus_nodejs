// POST /eyemobile/cadastrar-faltantes — cria na EyeMobile os produtos da planilha
// (aba Geral) que são NOVOS (SKU inexistente no catálogo): cria o produto e
// adiciona aos cardápios 49456 (preço) e 54643 (+3%) nos grupos da ABA.
// Os especiais (já no catálogo / SKU duplicado / combo) são ignorados (revisar).
// Escrita em PRODUÇÃO — auditado. Perm 16100. Body: { itens:[{codigo,valor,descricao,aba}] }

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16100, 0]);
const Eye = require('../../services/eyemobile');
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'post',
  route: '/cadastrar-faltantes',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    if (!Eye.disponivel()) return res.status(503).json({ message: 'Integração EyeMobile não configurada.' });
    const itens = (req.body && req.body.itens) || [];
    if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ message: 'Envie os itens da planilha (aba Geral).' });
    try {
      const r = await Eye.aplicarCadastros(itens);
      const criados = r.resultado.filter(x => !x.erro).length;
      Auditoria.registrar(app, {
        modulo: 'EyeMobile', submodulo: 'Cadastro', acao: 'CRIAR', severidade: 'WARN', req,
        entidade: 'produto', entidadeId: r.resultado.map(x => x.codigo).join(','),
        descricao: `Cadastrou ${criados} produto(s) novo(s) na EyeMobile`,
        meta: r.resultado
      });
      return res.json({ ok: true, ...r });
    } catch (err) {
      console.error('eyemobile/cadastrar-faltantes:', err.message);
      return res.status(502).json({ message: 'Erro ao cadastrar na EyeMobile: ' + err.message });
    }
  }
});

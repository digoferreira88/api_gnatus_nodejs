// POST /eyemobile/precos-aplicar — publica os preços da planilha (aba Geral) nos
// cardápios 49456 (preço) e 54643 (+3%). Recalcula no servidor e faz PUT por
// produto que muda. Escrita em PRODUÇÃO — auditado. Perm 16100.
// Body: { itens: [{ codigo, valor, descricao }] }

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16100, 0]);
const Eye = require('../../services/eyemobile');
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'post',
  route: '/precos-aplicar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    if (!Eye.disponivel()) return res.status(503).json({ message: 'Integração EyeMobile não configurada (chaves ausentes).' });
    const itens = (req.body && req.body.itens) || [];
    if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ message: 'Envie os itens da planilha (aba Geral).' });

    try {
      const r = await Eye.aplicarAlteracoes(itens);
      Auditoria.registrar(app, {
        modulo: 'EyeMobile', submodulo: 'Preços', acao: 'ATUALIZAR', severidade: 'WARN', req,
        entidade: 'menu', entidadeId: r.resultado.map(x => x.menuId).join(','),
        descricao: 'Atualizou preços EyeMobile — ' + r.resultado.map(x => `${x.nome}: ${x.aplicados}/${x.tentados} (erros ${x.erros})`).join(' · '),
        meta: r.resultado
      });
      return res.json({ ok: true, ...r });
    } catch (err) {
      console.error('eyemobile/precos-aplicar:', err.message);
      return res.status(502).json({ message: 'Erro ao publicar na EyeMobile: ' + err.message });
    }
  }
});

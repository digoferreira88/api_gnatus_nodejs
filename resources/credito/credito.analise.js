// GET /credito/analise/:cod/:loja
// Análise de Crédito 360° (interno + bureau em cache, quando houver). Perm 15100.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([15100]);
const Analise = require('../../services/creditoAnalise');
const Auditoria = require('../../services/auditoria');

const limpar = (p) => { delete p._scoreFinal; delete p._classificacao; delete p._status; delete p._nome; delete p._cnpj; return p; };

module.exports = (app) => ({
  verb: 'get',
  route: '/analise/:cod/:loja',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const cod = String(req.params.cod || '').trim();
    const loja = String(req.params.loja || '').trim();
    const contexto = String(req.query.contexto || '').trim().toUpperCase() || null;
    if (!cod || !loja) return res.status(400).json({ message: 'Código e loja do cliente são obrigatórios.' });

    try {
      const payload = await Analise.montar({ Pg, Protheus }, cod, loja, { contexto });
      if (!payload) return res.status(404).json({ message: 'Cliente não encontrado.' });

      Auditoria.registrar(app, {
        modulo: 'Crédito', submodulo: 'Análise', acao: 'CONSULTAR', severidade: 'INFO', req,
        entidade: 'cliente', entidadeId: `${cod}/${loja}`,
        descricao: `Análise de crédito de ${payload._nome} — score ${payload._scoreFinal} (${payload._classificacao.label}) · ${payload._status}`,
        meta: { scoreFinal: payload._scoreFinal, status: payload._status, contexto, comBureau: !!payload.bureau }
      });
      return res.json(limpar(payload));
    } catch (err) {
      console.error('Erro credito/analise:', err);
      return res.status(500).json({ message: 'Erro ao gerar análise de crédito: ' + err.message });
    }
  }
});

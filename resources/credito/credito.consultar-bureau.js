// POST /credito/consultar-bureau/:cod/:loja
// Dispara a consulta ao bureau externo (Quod) — GERA CUSTO. Usa cache (30d) salvo
// se já houver consulta recente, a menos que ?forcar=1. Recalcula a análise 360
// com o score externo combinado (blend). Permissão 15104.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([15104]);
const Bureau = require('../../services/creditoBureau');
const Analise = require('../../services/creditoAnalise');
const Auditoria = require('../../services/auditoria');

const limpar = (p) => { delete p._scoreFinal; delete p._classificacao; delete p._status; delete p._nome; delete p._cnpj; return p; };

module.exports = (app) => ({
  verb: 'post',
  route: '/consultar-bureau/:cod/:loja',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    const cod = String(req.params.cod || '').trim();
    const loja = String(req.params.loja || '').trim();
    const contexto = String(req.body?.contexto || req.query.contexto || '').trim().toUpperCase() || null;
    const forcar = String(req.query.forcar || req.body?.forcar || '') === '1';
    if (!cod || !loja) return res.status(400).json({ message: 'Código e loja do cliente são obrigatórios.' });

    try {
      const cad = await Protheus.connectAndQuery(
        `SELECT TOP 1 RTRIM(A1_CGC) cnpj, RTRIM(A1_NOME) nome FROM SA1010 WITH (NOLOCK)
          WHERE A1_COD=@cod AND A1_LOJA=@loja AND D_E_L_E_T_<>'*'`, { cod, loja });
      if (!cad.length) return res.status(404).json({ message: 'Cliente não encontrado.' });
      const cnpj = String(cad[0].cnpj || '').trim();
      if (!cnpj) return res.status(400).json({ message: 'Cliente sem CNPJ/CPF no cadastro — não é possível consultar o bureau.' });

      let bureau;
      try {
        const r = await Bureau.consultar({ Pg }, { cnpj, clienteCod: cod, clienteLoja: loja, usuarioId: user?.ID, forcar });
        bureau = r.resultado;
      } catch (e) {
        if (e.naoConfigurado) return res.status(409).json({ message: e.message, naoConfigurado: true });
        console.error('credito/consultar-bureau:', e.message);
        return res.status(502).json({ message: 'Falha na consulta ao bureau: ' + e.message });
      }

      const payload = await Analise.montar({ Pg, Protheus }, cod, loja, { contexto, bureau });

      Auditoria.registrar(app, {
        modulo: 'Crédito', submodulo: 'Bureau', acao: 'CONSULTA_EXTERNA', severidade: 'CRITICO', req,
        entidade: 'cliente', entidadeId: `${cod}/${loja}`,
        descricao: `Consulta ${bureau.fonte || 'bureau'} de ${cad[0].nome} (${cnpj})${bureau.doCache ? ' [cache]' : ''} — score final ${payload._scoreFinal}`,
        meta: { cnpj, fonte: bureau.fonte, doCache: bureau.doCache, scoreFinal: payload._scoreFinal, status: payload._status }
      });
      return res.json(limpar(payload));
    } catch (err) {
      console.error('Erro credito/consultar-bureau:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

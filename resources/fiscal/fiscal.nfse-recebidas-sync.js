// POST /fiscal/nfse-recebidas/sincronizar
// Puxa manualmente novas NFS-e do ADN (a partir do cursor de NSU) e grava em
// tab_nfse_recebida. O scheduler faz isso sozinho quando ligado; este endpoint
// serve pra validação/estreia e pra forçar uma atualização na hora. Perm 16001.
// Leitura no ADN (mTLS A1) + escrita no Postgres da intranet. Auditoria.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([16001, 0]);
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'post',
  route: '/nfse-recebidas/sincronizar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    if (!String(process.env.NFSE_CERT_PATH || '').trim()) {
      return res.status(503).json({ message: 'Certificado A1 (NFSE_CERT_PATH) não configurado — sincronização indisponível.' });
    }
    try {
      const Adn = require('../../services/nfseDistribuicaoAdn');
      const maxLotes = Math.min(Math.max(Number(req.body?.maxLotes) || 6, 1), 20);
      const r = await Adn.ingerir(app, { maxLotes });

      Auditoria.registrar(app, {
        modulo: 'Fiscal', submodulo: 'NFSeRecebidas',
        acao: 'SINCRONIZAR', severidade: 'INFO',
        req, entidade: 'nfse-adn', entidadeId: String(r.ultNSU),
        descricao: `Sincronizou NFS-e recebidas do ADN: ${r.novos} novas em ${r.lotes} lote(s), cursor NSU=${r.ultNSU}, status=${r.status}`,
        meta: r
      });

      return res.json({ ok: true, ...r });
    } catch (err) {
      console.error('fiscal/nfse-recebidas/sincronizar:', err.message);
      return res.status(502).json({ message: 'Falha ao sincronizar com o ADN: ' + err.message });
    }
  }
});

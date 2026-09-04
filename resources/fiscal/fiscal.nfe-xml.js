// GET /fiscal/nfe-xml/:doc/:serie — baixa o XML autorizado (procNFe) de uma NF de
// saída. Resolve a chave na SF2 (F2_CHVNFE) e busca o XML no endpoint REST custom
// do Protheus (gntnfe/xml). Devolve o .xml como download.
//
// Perm: Expedição (12001), Contas a Receber (8002), Fiscal (16001) ou SAC
// (6001/6002) — quem já vê a nota nessas telas pode baixar o XML.
//
// ⚠️ 04/09/2026: o endpoint `gntnfe/xml` do Protheus está com BUG (ignora o
// ?chave= da querystring e usa uma chave de exemplo fixa → 404). Enquanto o Diego
// não corrige, este endpoint devolve 502 com mensagem clara em vez de um XML
// inválido. Path do WS configurável em PROTHEUS_API_PATH_NFE_XML.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([12001, 8002, 16001, 6001, 6002]);
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/nfe-xml/:doc/:serie',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const doc = trim(req.params.doc);
    const serie = trim(req.params.serie);
    if (!doc || !serie) return res.status(400).json({ message: 'doc e serie sao obrigatorios.' });

    try {
      // 1) chave da NFe na SF2
      const rows = await Protheus.connectAndQuery(`
        SELECT TOP 1 RTRIM(F2_CHVNFE) chave, RTRIM(ISNULL(F2_STATUS,'')) status
          FROM SF2010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*' AND F2_FILIAL = '01' AND F2_DOC = @doc AND F2_SERIE = @serie`,
        { doc, serie });
      if (!rows.length) return res.status(404).json({ message: `NF ${doc}/${serie} nao encontrada.` });
      const chave = trim(rows[0].chave);
      if (!/^\d{44}$/.test(chave)) {
        return res.status(409).json({ message: `NF ${doc}/${serie} sem chave de NFe (nao autorizada/transmitida ainda).` });
      }

      // 2) busca o XML no Protheus (gntnfe/xml)
      const apiUrl  = trim(process.env.PROTHEUS_API_URL);
      const apiUser = trim(process.env.PROTHEUS_API_USER);
      const apiPass = trim(process.env.PROTHEUS_API_PASS);
      const path    = trim(process.env.PROTHEUS_API_PATH_NFE_XML) || '/gntnfe/xml';
      if (!apiUrl || !apiUser || !apiPass) {
        return res.status(503).json({ message: 'API Protheus nao configurada (.env).' });
      }
      const url = apiUrl.replace(/\/$/, '') + path + '?chave=' + encodeURIComponent(chave);
      const auth = 'Basic ' + Buffer.from(`${apiUser}:${apiPass}`).toString('base64');

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let r, body;
      try {
        r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/xml' }, signal: ctrl.signal });
        body = await r.text();
      } finally { clearTimeout(timer); }

      // O XML autorizado começa com <?xml ... e contém procNFe/nfeProc. Se vier
      // JSON/HTML de erro (o bug atual), NÃO entrega — surfaça a mensagem.
      const ehXml = /^\s*<\?xml/i.test(body) && /(nfeProc|procNFe|<NFe)/i.test(body);
      if (!r.ok || !ehXml) {
        console.warn(`fiscal/nfe-xml: gntnfe devolveu ${r.status} nao-XML p/ chave ${chave}: ${body.slice(0, 200)}`);
        return res.status(502).json({
          message: `XML da NF ${doc}/${serie} indisponivel no Protheus no momento (endpoint gntnfe). Chamado aberto com o TI Protheus.`,
          chave, protheusStatus: r.status
        });
      }

      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="NFe-${doc}-${serie}-${chave}.xml"`);
      return res.send(body);
    } catch (err) {
      console.error('fiscal/nfe-xml:', err);
      return res.status(500).json({ message: 'Erro ao obter o XML.' });
    }
  }
});

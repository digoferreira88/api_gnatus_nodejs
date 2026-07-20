// GET /financeiro/liberacao/anexo/:codObj
//
// Baixa um conhecimento (anexo) do Protheus pra tela de Liberação Financeira.
// Mesma mecânica do download de anexos de Aprovações (TOTVS Documents):
//   GET {PROTHEUS_API_URL}/api/crm/v1/documents/{InternalId}
//   InternalId = "  " (2 espaços) + AC9_CODOBJ (10 chars)
//   Resposta: { ListOfKnowledge: [{ FileName, EncodeDocument(base64) }] }
//
// Permissão 8006 (edição) ou 8007 (somente visualização).

const trim = (v) => String(v || '').trim();
const Auditoria = require('../../services/auditoria');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006, 8007]);

const mimeFromExt = (name) => {
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  const map = {
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    csv: 'text/csv',
    xml: 'application/xml',
    json: 'application/json',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
    msg: 'application/vnd.ms-outlook', eml: 'message/rfc822'
  };
  return map[ext] || 'application/octet-stream';
};

// Tipos que abrem preview inline com segurança (renderizados como dados).
const SAFE_INLINE = new Set([
  'application/pdf', 'text/plain; charset=utf-8', 'text/csv',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp'
]);

module.exports = (app) => ({
  verb: 'get',
  route: '/liberacao/anexo/:codObj',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const codObj = trim(req.params.codObj);
    if (!codObj || codObj.length !== 10) {
      return res.status(400).json({ message: 'codObj inválido (deve ter 10 chars).' });
    }

    const apiUrl  = process.env.PROTHEUS_API_URL;
    const apiUser = process.env.PROTHEUS_API_USER;
    const apiPass = process.env.PROTHEUS_API_PASS;
    if (!apiUrl || !apiUser || !apiPass) {
      return res.status(503).json({ message: 'API Protheus não configurada.' });
    }

    const internalId = '  ' + codObj;
    const url = apiUrl.replace(/\/$/, '') + '/api/crm/v1/documents/' + encodeURIComponent(internalId);
    const auth = 'Basic ' + Buffer.from(`${apiUser}:${apiPass}`).toString('base64');

    try {
      const r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
      const txt = await r.text();
      if (!r.ok) {
        return res.status(r.status === 404 ? 404 : 502).json({
          message: 'Erro ao buscar anexo no Protheus.', status: r.status, body: txt.slice(0, 500)
        });
      }
      let json;
      try { json = JSON.parse(txt); } catch { return res.status(502).json({ message: 'Resposta TOTVS inválida.' }); }

      const knw = (json.ListOfKnowledge || [])[0];
      if (!knw || !knw.EncodeDocument) {
        return res.status(404).json({ message: 'Documento sem conteúdo binário.' });
      }

      const fileName = trim(knw.FileName) || `anexo_${codObj}.bin`;
      const buffer = Buffer.from(knw.EncodeDocument, 'base64');
      const mime = mimeFromExt(fileName);
      const safeName = fileName.replace(/[^\x20-\x7E]/g, '_');
      const disposicao = SAFE_INLINE.has(mime) ? 'inline' : 'attachment';

      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Content-Disposition',
        `${disposicao}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=300');

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'LiberacaoFinanceira', acao: 'DOWNLOAD_ANEXO', severidade: 'AVISO',
        req, entidade: 'liberacao_anexo', entidadeId: codObj,
        descricao: `Baixou conhecimento "${fileName}" (${(buffer.length / 1024).toFixed(0)}KB)`,
        meta: { codObj, fileName, sizeBytes: buffer.length, mime }
      });

      return res.end(buffer);
    } catch (err) {
      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'LiberacaoFinanceira', acao: 'DOWNLOAD_ANEXO_FAIL', severidade: 'ALERTA',
        req, entidade: 'liberacao_anexo', entidadeId: codObj,
        descricao: `Falha ao baixar conhecimento: ${err.message}`,
        meta: { codObj, erro: err.message }
      });
      return res.status(500).json({ message: 'Erro ao baixar anexo: ' + err.message });
    }
  }
});

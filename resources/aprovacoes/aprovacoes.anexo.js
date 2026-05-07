// Baixa anexo do banco de conhecimento (Conhecimento) do Protheus.
//
// Endpoint TOTVS: GET {PROTHEUS_API_URL}/api/crm/v1/documents/{InternalId}
// Doc oficial: https://github.com/totvs/ttalk-standard-message → Documents_v1_000.json
//   Adapter: CRMS120.prw  | Versão mínima: 12.1.21
//
// InternalId = AC9_FILIAL (8 chars, padded com espaços) + AC9_CODOBJ (10 chars).
// Na Gnatus AC9_FILIAL vem vazio, então o InternalId vira "        " + codObj.
// Empiricamente o servidor aceita só "  " (2 espaços) + codObj.
//
// Resposta TOTVS:
//   { ListOfKnowledge: [{ FileName, FileDescription, FileSizeBytes, EncodeDocument }] }
// EncodeDocument = conteúdo do arquivo em base64.

const trim = (v) => String(v || '').trim();
const Auditoria = require('../../services/auditoria');

const mimeFromExt = (name) => {
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  const map = {
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    csv: 'text/csv',
    xml: 'application/xml',
    json: 'application/json',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
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

module.exports = (app) => ({
  verb: 'get',
  route: '/anexo/:codObj',

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

    // InternalId = "  " (2 espaços) + codObj — formato observado empiricamente
    const internalId = '  ' + codObj;
    const url = apiUrl.replace(/\/$/, '') + '/api/crm/v1/documents/' + encodeURIComponent(internalId);
    const auth = 'Basic ' + Buffer.from(`${apiUser}:${apiPass}`).toString('base64');

    try {
      const r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
      const txt = await r.text();
      if (!r.ok) {
        return res.status(r.status === 404 ? 404 : 502).json({
          message: 'Erro ao buscar anexo no Protheus.',
          status: r.status,
          body: txt.slice(0, 500)
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

      // ASCII-safe filename + UTF-8 RFC 5987 (suporta acentos)
      const safeName = fileName.replace(/[^\x20-\x7E]/g, '_');
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Content-Disposition',
        `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.setHeader('Cache-Control', 'private, max-age=300');

      // Auditoria de acesso a documento (rastreio de quem viu o que)
      Auditoria.registrar(app, {
        modulo: 'Compras', submodulo: 'Aprovacoes', acao: 'DOWNLOAD_ANEXO', severidade: 'AVISO',
        req, entidade: 'aprovacao_anexo', entidadeId: codObj,
        descricao: `Baixou anexo "${fileName}" (${(buffer.length / 1024).toFixed(0)}KB)`,
        meta: { codObj, fileName, sizeBytes: buffer.length, mime }
      });

      return res.end(buffer);
    } catch (err) {
      Auditoria.registrar(app, {
        modulo: 'Compras', submodulo: 'Aprovacoes', acao: 'DOWNLOAD_ANEXO_FAIL', severidade: 'ALERTA',
        req, entidade: 'aprovacao_anexo', entidadeId: codObj,
        descricao: `Falha ao baixar anexo: ${err.message}`,
        meta: { codObj, erro: err.message }
      });
      return res.status(500).json({ message: 'Erro ao baixar anexo: ' + err.message });
    }
  }
});

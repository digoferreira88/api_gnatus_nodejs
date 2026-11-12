// GET /ciosp/midia-arquivo/:arquivo  (ANÔNIMO — sem login)
// Entrega uma foto ou catálogo do CIOSP. É material público de divulgação, e a tag
// <img> não manda o token. Só nomes no formato gerado (sha256 + extensão) — nada de
// caminho arbitrário. Nome por conteúdo = cache eterno no navegador.

const fs = require('fs');
const path = require('path');
const Midia = require('../../services/ciospMidia');

module.exports = () => ({
  verb: 'get',
  route: '/midia-arquivo/:arquivo',
  anonymous: true,

  handler: async (req, res) => {
    const arquivo = String(req.params.arquivo || '');
    if (!Midia.nomeValido(arquivo)) return res.status(404).json({ message: 'Arquivo não encontrado.' });
    const caminho = path.join(Midia.dirMidia(), arquivo);
    if (!fs.existsSync(caminho)) return res.status(404).json({ message: 'Arquivo não encontrado.' });
    res.setHeader('Content-Type', Midia.mimeDoNome(arquivo));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return fs.createReadStream(caminho).pipe(res);
  }
});

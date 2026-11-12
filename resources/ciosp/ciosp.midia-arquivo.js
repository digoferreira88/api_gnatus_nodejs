// GET /ciosp/midia-arquivo/:arquivo  (ANÔNIMO — sem login)
// Entrega uma foto ou catálogo do CIOSP. É material público de divulgação, e a tag
// <img> não manda o token. Só nomes no formato gerado (sha256 + extensão) — nada de
// caminho arbitrário. Nome por conteúdo = cache eterno no navegador.
//
// res.sendFile (e não createReadStream().pipe): erro de leitura (permissão, arquivo
// sumido, pasta no lugar do arquivo) vira 404 em vez de exceção não tratada que
// derrubaria a API — rota sem login não pode ter esse poder. De quebra, dá Range,
// Content-Length e ETag para os PDFs grandes.

const Midia = require('../../services/ciospMidia');

module.exports = () => ({
  verb: 'get',
  route: '/midia-arquivo/:arquivo',
  anonymous: true,

  handler: (req, res) => {
    const arquivo = String(req.params.arquivo || '');
    if (!Midia.nomeValido(arquivo)) return res.status(404).json({ message: 'Arquivo não encontrado.' });
    return res.sendFile(arquivo, {
      root: Midia.dirMidia(),
      maxAge: '1y',
      immutable: true,
      headers: { 'Content-Type': Midia.mimeDoNome(arquivo), 'X-Content-Type-Options': 'nosniff' }
    }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ message: 'Arquivo não encontrado.' });
    });
  }
});

// GET /simulador/app — serve o Simulador de Margens (index.html + calc.js) como
// um documento HTML ÚNICO e AUTENTICADO. O calc.js é embutido inline no HTML pra
// virar um doc self-contained que a tela React /simulador embute num <iframe
// srcdoc>. App IDÊNTICO ao standalone (mesmos arquivos em ../../simulador/).
//
// Perm 17001. Só quem tem a permissão (ou admin) acessa — é o gate por login que
// o simulador standalone não tinha.

const fs = require('fs');
const path = require('path');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([17001, 0]);

const DIR = path.join(__dirname, '..', '..', 'simulador');
let _htmlCache = null;

// Lê index.html + calc.js e inlina o calc.js no lugar do <script src="calc.js">.
// (Escapa </script> do JS por segurança, embora o calc.js seja só dados+cálculo.)
function montarHtml() {
  if (_htmlCache) return _htmlCache;
  let html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const calc = fs.readFileSync(path.join(DIR, 'calc.js'), 'utf8').replace(/<\/script>/gi, '<\\/script>');
  html = html.replace(/<script\s+src=["']calc\.js["']\s*><\/script>/i, `<script>\n${calc}\n</script>`);
  _htmlCache = html;
  return html;
}

module.exports = (app) => ({
  verb: 'get',
  route: '/app',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    try {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(montarHtml());
    } catch (e) {
      console.error('simulador/app:', e.message);
      return res.status(500).json({ message: 'Erro ao carregar o simulador: ' + e.message });
    }
  }
});

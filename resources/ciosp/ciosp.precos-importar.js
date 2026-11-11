// POST /ciosp/precos/importar  (multipart: 'arquivo' = planilha modelo .xlsx; campos edicao, simular)
// Importa a Tabela Comercial da edição. Perm 19004.
//
// Com qualquer erro na planilha: 422 com a lista por linha e NADA gravado.
// simular=1: valida e devolve uma amostra, sem gravar (a tela usa antes de confirmar).
// Senão: substitui a tabela inteira da edição numa transação.

const multer = require('multer');
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const Auditoria = require('../../services/auditoria');
const Tabela = require('../../services/ciospTabela');
const Edicao = require('../../services/ciospEdicao');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

module.exports = (app) => ({
  verb: 'post',
  route: '/precos/importar',
  middlewares: [requirePerm(app), upload.single('arquivo')],

  handler: async (req, res) => {
    const user = req.user && req.user[0];
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'Envie a planilha .xlsx no campo "arquivo".' });
    }
    const edicao = String(req.body?.edicao || '').trim().slice(0, 40);
    if (!edicao) return res.status(400).json({ message: 'Informe a edição.' });
    const simular = ['1', 'true', 'sim'].includes(String(req.body?.simular || '').toLowerCase());

    try {
      const { linhas, erros, avisos } = await Tabela.lerPlanilha(req.file.buffer);
      if (erros.length) {
        return res.status(422).json({ message: `A planilha tem ${erros.length} erro(s). Nada foi importado.`, erros, avisos });
      }
      if (!linhas.length) {
        return res.status(422).json({ message: 'A planilha não tem nenhuma linha preenchida.', erros: [], avisos });
      }
      if (simular) {
        return res.json({ ok: true, simulacao: true, linhas: linhas.length, avisos, amostra: linhas.slice(0, 5) });
      }

      const produtos = await Edicao.resolverProdutos(app, linhas.map(l => l.codigo));
      const r = await Edicao.importarTabela(app, {
        edicao, linhas, produtos, arquivo: req.file.originalname, usuarioId: user?.id ? Number(user.id) : null
      });
      Auditoria.registrar(app, {
        modulo: 'CIOSP', submodulo: 'Tabela de preços', acao: 'IMPORTAR', severidade: 'AVISO',
        req, entidade: 'edicao', entidadeId: edicao,
        descricao: `Importou ${r.linhas} linhas da Tabela Comercial (${edicao}); ${r.comProduto} com produto no Protheus`
      });
      return res.json({ ok: true, ...r, avisos });
    } catch (err) {
      console.error('ciosp/precos/importar:', err.message);
      return res.status(500).json({ message: 'Erro ao importar a tabela: ' + err.message });
    }
  }
});

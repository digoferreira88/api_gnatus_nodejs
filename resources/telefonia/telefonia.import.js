// POST /telefonia/import — importa o XLSX de telefonia movel (planilha legada).
// Multipart: campo 'arquivo'. Query: ?dry=true → so retorna preview.
// Permissao 1027.

const multer = require('multer');
const TelefoniaImport = require('../../services/telefoniaImport');
const Auditoria = require('../../services/auditoria');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1027]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

module.exports = (app) => ({
  verb: 'post',
  route: '/import',
  middlewares: [requirePerm(app), upload.single('arquivo')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const dryRun = String(req.query.dry || '').toLowerCase() === 'true';

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'Arquivo .xlsx obrigatorio (campo "arquivo").' });
    }

    try {
      const parsed = await TelefoniaImport.parsePlanilha(req.file.buffer);
      const preview = {
        contas: parsed.contas.map(c => ({
          operadora: c.operadora,
          numero_conta: c.numeroConta,
          numero_cliente: c.numeroCliente,
          razao_social: c.razaoSocial,
          qt_linhas: c.linhas.length,
          amostra: c.linhas.slice(0, 3).map(l => ({
            numero: l.numero, pessoa: l.pessoa, departamento: l.departamento,
            plano: l.plano, gb: l.franquiaGb, status: l.status,
            ativacao: l.dataAtivacao && l.dataAtivacao.toISOString().slice(0, 10),
            vencimento: l.dataVencimento && l.dataVencimento.toISOString().slice(0, 10)
          }))
        })),
        departamentos: [...parsed.departamentos],
        totais: parsed.totais
      };

      if (dryRun) return res.json({ dry_run: true, preview });

      const stats = await TelefoniaImport.aplicarNoBanco(Pg, parsed, { idUsuario: user?.ID });

      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'TelefoniaMovel',
        acao: 'IMPORT', severidade: 'AVISO',
        req, entidade: 'telefonia_import', entidadeId: req.file.originalname,
        descricao: `Importou planilha "${req.file.originalname}" (${stats.linhasNovas} novas, ${stats.linhasAtualizadas} atualizadas)`,
        meta: { ...stats, totais: parsed.totais, arquivo: req.file.originalname, tamanho: req.file.size }
      });

      return res.json({ ok: true, stats, preview });
    } catch (err) {
      console.error('telefonia/import:', err);
      return res.status(500).json({ message: 'Erro ao importar: ' + err.message });
    }
  }
});

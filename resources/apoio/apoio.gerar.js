// POST /apoio/gerar — recebe o XLSX/CSV via multipart, perfila e chama Claude.
// Salva o resultado em tab_apoio_apresentacao e retorna a apresentacao gerada.
// Permissao 5001.

const multer = require('multer');
const Perfil = require('../../services/apoioPerfil');
const Apresentacao = require('../../services/apoioApresentacao');
const Auditoria = require('../../services/auditoria');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5001]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

module.exports = (app) => ({
  verb: 'post',
  route: '/gerar',
  middlewares: [requirePerm(app), upload.single('arquivo')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'Arquivo (.xlsx ou .csv) obrigatorio (campo "arquivo").' });
    }
    if (req.file.size > 25 * 1024 * 1024) {
      return res.status(413).json({ message: 'Arquivo muito grande (max 25MB).' });
    }
    const ext = (req.file.originalname || '').toLowerCase().split('.').pop();
    if (ext === 'xls') {
      return res.status(400).json({ message: 'Formato .xls (Excel 97-2003) nao suportado. Abra no Excel e salve como .xlsx.' });
    }
    if (!['xlsx', 'csv'].includes(ext)) {
      return res.status(400).json({ message: 'Formato nao suportado. Aceita XLSX ou CSV.' });
    }

    const t0 = Date.now();
    let perfil = null;
    try {
      perfil = await Perfil.perfilarBuffer(req.file.buffer, req.file.originalname);
    } catch (e) {
      return res.status(400).json({ message: 'Falha ao ler o arquivo: ' + e.message });
    }
    if (!perfil.abas.length) {
      return res.status(400).json({ message: 'Nao foi possivel identificar tabelas no arquivo.' });
    }

    // Perfil "magro" pra IA — sem as linhas brutas (que sao soh pro grafico no front)
    const perfilParaIA = {
      ...perfil,
      abas: perfil.abas.map(a => ({ nome: a.nome, linhas: a.linhas, colunas: a.colunas, amostra: a.amostra }))
    };

    let r;
    try {
      r = await Apresentacao.gerarApresentacao(perfilParaIA);
    } catch (e) {
      Auditoria.registrar(app, {
        modulo: 'ApoioGerencial', submodulo: 'Apresentacao',
        acao: 'GENERATE_FAIL', severidade: 'ALERTA',
        req, entidade: 'apoio_apresentacao', entidadeId: req.file.originalname,
        descricao: `Falha ao gerar apresentacao: ${e.message}`,
        meta: { arquivo: req.file.originalname, tamanho: req.file.size, erro: e.message }
      });
      return res.status(502).json({ message: 'IA nao conseguiu gerar a apresentacao: ' + e.message });
    }

    let id = null;
    try {
      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_apoio_apresentacao
          (id_user, nome_arquivo, titulo, subtitulo, perfil, dados,
           modelo_ia, tokens_in, tokens_out, custo_estimado)
        VALUES (@uid, @arq, @tit, @sub, @perf::jsonb, @dad::jsonb,
                @mod, @ti, @to, @cu)
        RETURNING id`,
        {
          uid: user?.ID || null,
          arq: req.file.originalname,
          tit: String(r.dados.titulo || '').slice(0, 200),
          sub: String(r.dados.subtitulo || '').slice(0, 300),
          perf: JSON.stringify(perfilParaIA),    // salva versao "magra" no banco
          dad: JSON.stringify(r.dados),
          mod: r.model,
          ti: r.tokensIn,
          to: r.tokensOut,
          cu: r.custo
        }
      );
      id = ins[0].id;
    } catch (e) { console.warn('apoio.gerar save:', e.message); }

    Auditoria.registrar(app, {
      modulo: 'ApoioGerencial', submodulo: 'Apresentacao',
      acao: 'GENERATE', severidade: 'INFO',
      req, entidade: 'apoio_apresentacao', entidadeId: String(id || ''),
      descricao: `Gerou apresentacao "${r.dados.titulo}" a partir de "${req.file.originalname}"`,
      meta: { id, modelo: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, custo: r.custo, tema: r.dados.tema_detectado }
    });

    return res.json({
      ok: true,
      id,
      perfil,
      apresentacao: r.dados,
      meta: {
        modelo: r.model,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        custo: r.custo,
        duracaoMs: Date.now() - t0
      }
    });
  }
});

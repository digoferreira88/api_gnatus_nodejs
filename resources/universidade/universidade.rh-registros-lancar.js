// POST /universidade/rh/registros — lança um treinamento realizado para 1 ou mais
// colaboradores (turma presencial fora do sistema, leitura de procedimento, treinamento
// externo). É o caminho de quem NÃO tem login na intranet (fábrica).
// multipart/form-data:
//   dados  (texto JSON) = { cursoId, versaoId?, dataRealizacao, cargaH, modalidade, instrutor, local,
//                           verificacao (avaliacao|observacao|na), observacao,
//                           participantes: [{ colaboradorId, resultado?, nota? }] }
//   anexo  (arquivo, opcional) = lista de presença assinada / evidência (PDF, JPG, PNG; até 15 MB)
// Perm 15004/15003.

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { ESCREVER, UPLOAD_ROOT, requirePerm, txt, int, num, dataISO, usuario, audit } = require('./_rh');
const UniRh = require('../../services/universidadeRh');

const TIPOS = ['application/pdf', 'image/jpeg', 'image/png'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(UPLOAD_ROOT, 'universidade', 'registros');
      fs.mkdir(dir, { recursive: true }, err => cb(err || null, dir));
    },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 150)}`)
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => TIPOS.includes(file.mimetype)
    ? cb(null, true)
    : cb(new Error('Anexo deve ser PDF, JPG ou PNG.'))
}).single('anexo');

const comUpload = (req, res, next) => upload(req, res, (err) => {
  if (err) return res.status(400).json({ message: err.code === 'LIMIT_FILE_SIZE' ? 'Anexo maior que 15 MB.' : err.message });
  next();
});

const MODALIDADES = ['presencial', 'online', 'ead', 'externo'];
const VERIF = ['avaliacao', 'observacao', 'na'];

module.exports = (app) => ({
  verb: 'post',
  route: '/rh/registros',
  middlewares: [requirePerm(app, ESCREVER), comUpload],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const u = usuario(req);
    const descarta = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
    let d;
    try { d = typeof req.body?.dados === 'string' ? JSON.parse(req.body.dados) : (req.body?.dados || req.body || {}); }
    catch { descarta(); return res.status(400).json({ message: 'Campo "dados" não é um JSON válido.' }); }

    const cursoId = int(d.cursoId);
    const data = dataISO(d.dataRealizacao);
    const modalidade = MODALIDADES.includes(d.modalidade) ? d.modalidade : 'presencial';
    const verificacao = VERIF.includes(d.verificacao) ? d.verificacao : 'na';
    const parts = (Array.isArray(d.participantes) ? d.participantes : [])
      .map(p => ({
        colaboradorId: int(p.colaboradorId),
        resultado: p.resultado === 'reprovado' ? 'reprovado' : 'aprovado',
        nota: num(p.nota)
      }))
      .filter(p => p.colaboradorId);
    const unicos = [...new Map(parts.map(p => [p.colaboradorId, p])).values()];

    const erro = (m, s = 400) => { descarta(); return res.status(s).json({ message: m }); };
    if (!cursoId) return erro('Escolha o curso.');
    if (!data) return erro('Informe a data de realização.');
    if (data > UniRh.hojeISO()) return erro('A data de realização não pode ser futura.');
    if (!unicos.length) return erro('Inclua pelo menos um participante.');
    if (unicos.some(p => p.nota != null && (p.nota < 0 || p.nota > 100))) return erro('Nota deve ficar entre 0 e 100.');

    const curso = await Pg.connectAndQuery(`SELECT id, codigo, titulo, carga_horaria_h FROM tab_uni_curso WHERE id = @id`, { id: cursoId });
    if (!curso.length) return erro('Curso não encontrado.', 404);

    // Versão: a informada (do mesmo curso) ou a que estava vigente na data do treinamento.
    let versaoId = int(d.versaoId) || null;
    if (versaoId) {
      const v = await Pg.connectAndQuery(
        `SELECT 1 FROM tab_uni_curso_versao WHERE id = @v AND curso_id = @c AND status <> 'rascunho'`, { v: versaoId, c: cursoId });
      if (!v.length) return erro('A versão escolhida não é uma versão publicada deste curso.');
    } else {
      const v = await Pg.connectAndQuery(`
        SELECT id FROM tab_uni_curso_versao
         WHERE curso_id = @c AND status <> 'rascunho' AND vigente_desde <= @d
         ORDER BY vigente_desde DESC, id DESC LIMIT 1`, { c: cursoId, d: data });
      versaoId = v[0]?.id || null;
    }

    const ids = unicos.map(p => p.colaboradorId);
    const cols = await Pg.connectAndQuery(`SELECT id FROM tab_uni_colaborador WHERE id = ANY(@ids::int[])`, { ids });
    if (cols.length !== ids.length) return erro('Há participante que não está no cadastro de colaboradores.');

    const cargaH = num(d.cargaH) ?? Number(curso[0].carga_horaria_h) ?? null;
    const relPath = req.file ? path.relative(UPLOAD_ROOT, req.file.path).replace(/\\/g, '/') : null;

    let loteId;
    try {
      loteId = await Pg.withTransaction(async (cli) => {
        const l = await cli.query(`
          INSERT INTO tab_uni_registro_lote (curso_id, versao_id, data_realizacao, carga_h, modalidade, instrutor, local,
                 verificacao, observacao, origem, anexo_path, anexo_nome, anexo_mime, anexo_tamanho, criado_por)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'lote', $10, $11, $12, $13, $14) RETURNING id`,
          [cursoId, versaoId, data, cargaH, modalidade, txt(d.instrutor, 160), txt(d.local, 160), verificacao,
           txt(d.observacao, 4000), relPath, req.file?.originalname || null, req.file?.mimetype || null,
           req.file?.size || null, u.ID || null]);
        const lid = l.rows[0].id;
        await cli.query(`
          INSERT INTO tab_uni_registro (colaborador_id, curso_id, versao_id, lote_id, data_realizacao, carga_h, modalidade,
                 instrutor, origem, verificacao, nota, resultado, registrado_por)
          SELECT x.colaborador_id, $1, $2, $3, $4, $5, $6, $7, 'lote', $8, x.nota, x.resultado, $9
            FROM jsonb_to_recordset($10::jsonb) AS x(colaborador_id int, nota numeric, resultado text)`,
          [cursoId, versaoId, lid, data, cargaH, modalidade, txt(d.instrutor, 160), verificacao, u.ID || null,
           JSON.stringify(unicos.map(p => ({ colaborador_id: p.colaboradorId, nota: p.nota, resultado: p.resultado })))]);
        return lid;
      });
    } catch (err) {
      descarta();
      throw err;
    }

    await audit(app, req, 'CRIAR', 'uni_registro_lote', loteId,
      `Lançou ${curso[0].codigo} — ${curso[0].titulo} em ${data} para ${unicos.length} colaborador(es)` +
      (req.file ? ' (com anexo)' : ''), { cursoId, versaoId, data, modalidade, verificacao, participantes: unicos });

    return res.json({ ok: true, loteId, registros: unicos.length, versaoId });
  }
});

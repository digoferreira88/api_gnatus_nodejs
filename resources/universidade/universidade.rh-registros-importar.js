// POST /universidade/rh/registros/importar[?dry=1] — importa o HISTÓRICO de treinamentos
// já feitos (SULTS, planilhas, listas de presença em papel), p/ ninguém aparecer pendente
// de algo que já fez. multipart: arquivo (.xlsx).
// Colunas (cabeçalho em qualquer das 10 primeiras linhas, nome flexível):
//   CPF | Matrícula | Filial | Nome | Curso (código ou título) | Data | Carga horária |
//   Instrutor | Modalidade | Resultado | Nota | Observação
// Pessoa: por CPF; sem CPF, por matrícula (+ filial se houver duplicidade).
// Agrupa por curso+data+instrutor+modalidade em lotes origem 'legado'.
// Idempotente: linha igual a um registro legado já existente (pessoa+curso+data) é pulada.
// ?dry=1 só valida e devolve a prévia. Perm 15004/15003.

const multer = require('multer');
const ExcelJS = require('exceljs');
const { ESCREVER, requirePerm, usuario, audit } = require('./_rh');
const UniRh = require('../../services/universidadeRh');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }).single('arquivo');
const comUpload = (req, res, next) => upload(req, res, (err) => {
  if (err) return res.status(400).json({ message: err.code === 'LIMIT_FILE_SIZE' ? 'Planilha maior que 20 MB.' : err.message });
  next();
});

const norm = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const T = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };
const cellVal = (cell) => {
  const v = cell ? cell.value : null;
  if (v && typeof v === 'object') {
    if (v instanceof Date) return v;
    if (v.result !== undefined) return v.result;
    if (v.text) return v.text;
    if (v.richText) return v.richText.map(t => t.text).join('');
    return '';
  }
  return v;
};
const toISO = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) { // serial do Excel
    return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
};

const ALIAS = {
  cpf: ['cpf', 'documento'],
  matricula: ['matricula', 'mat', 'matr', 'registro'],
  filial: ['filial'],
  nome: ['nome', 'colaborador', 'funcionario', 'participante', 'aluno'],
  curso: ['curso', 'codigo do curso', 'cod curso', 'treinamento', 'codigo', 'titulo', 'modulo', 'codigo do modulo'],
  data: ['data', 'data de realizacao', 'data realizacao', 'realizado em', 'data do treinamento', 'conclusao', 'data de conclusao'],
  carga: ['carga horaria', 'carga', 'horas', 'ch'],
  instrutor: ['instrutor', 'professor', 'ministrante', 'responsavel'],
  modalidade: ['modalidade', 'formato'],
  resultado: ['resultado', 'status', 'situacao', 'aprovado'],
  nota: ['nota', 'pontuacao'],
  observacao: ['observacao', 'obs', 'observacoes']
};

function detectarLayout(ws) {
  for (let r = 1; r <= Math.min(ws.rowCount, 10); r++) {
    const map = {};
    ws.getRow(r).eachCell((cell, col) => {
      const h = norm(cellVal(cell));
      for (const [campo, nomes] of Object.entries(ALIAS)) {
        if (!map[campo] && nomes.includes(h)) map[campo] = col;
      }
    });
    if (map.curso && map.data && (map.cpf || map.matricula)) return { linhaCab: r, map };
  }
  return null;
}

const modalidadeDe = (v) => {
  const s = norm(v);
  if (!s) return 'presencial';
  if (s.startsWith('ead') || s === 'e' || s.includes('gravad')) return 'ead';
  if (s.includes('online') || s.includes('on-line') || s.includes('teams')) return 'online';
  if (s.includes('extern')) return 'externo';
  return 'presencial';
};
const resultadoDe = (v) => /reprov|inapto|nao aprov/.test(norm(v)) ? 'reprovado' : 'aprovado';

module.exports = (app) => ({
  verb: 'post',
  route: '/rh/registros/importar',
  middlewares: [requirePerm(app, ESCREVER), comUpload],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const u = usuario(req);
    const dry = ['1', 'true'].includes(String(req.query.dry || ''));
    if (!req.file) return res.status(400).json({ message: 'Envie a planilha (.xlsx) no campo "arquivo".' });

    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(req.file.buffer); } catch { return res.status(400).json({ message: 'Arquivo não é um .xlsx válido.' }); }
    let ws = null; let lay = null;
    for (const w of wb.worksheets) { const l = detectarLayout(w); if (l) { ws = w; lay = l; break; } }
    if (!ws) {
      return res.status(400).json({ message: 'Não achei o cabeçalho. A planilha precisa das colunas Curso, Data e CPF (ou Matrícula).' });
    }

    const [cols, cursos] = await Promise.all([
      Pg.connectAndQuery(`SELECT id, cpf, filial, matricula, nome FROM tab_uni_colaborador`),
      Pg.connectAndQuery(`SELECT id, codigo, titulo, carga_horaria_h FROM tab_uni_curso`)
    ]);
    const porCpf = new Map(cols.filter(c => c.cpf).map(c => [c.cpf, c]));
    const porMat = new Map();
    cols.forEach(c => { const k = String(c.matricula || ''); if (!porMat.has(k)) porMat.set(k, []); porMat.get(k).push(c); });
    const cursoPorCod = new Map(cursos.map(c => [norm(c.codigo), c]));
    const cursoPorTit = new Map(cursos.map(c => [norm(c.titulo), c]));

    const linhas = [];
    const hoje = UniRh.hojeISO();
    for (let r = lay.linhaCab + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const g = (campo) => lay.map[campo] ? cellVal(row.getCell(lay.map[campo])) : null;
      const cpf = soDig(g('cpf'));
      const mat = soDig(g('matricula'));
      const cursoTxt = T(g('curso'));
      if (!cpf && !mat && !cursoTxt) continue; // linha vazia
      const l = { linha: r, nome: T(g('nome')), cursoTxt, erros: [] };

      let col = cpf ? porCpf.get(cpf.padStart(11, '0')) || porCpf.get(cpf) : null;
      if (!col && mat) {
        const cands = (porMat.get(mat.padStart(6, '0')) || porMat.get(mat) || []);
        const fil = soDig(g('filial'));
        const f = fil ? cands.filter(c => String(c.filial) === fil.padStart(2, '0')) : cands;
        if (f.length === 1) col = f[0];
        else if (f.length > 1) l.erros.push('matrícula existe em mais de uma filial — informe CPF ou Filial');
      }
      if (!col && !l.erros.length) l.erros.push('colaborador não encontrado entre os ativos (desligado? CPF/matrícula errado?)');

      const curso = cursoTxt ? (cursoPorCod.get(norm(cursoTxt)) || cursoPorTit.get(norm(cursoTxt))) : null;
      if (!curso) l.erros.push(cursoTxt ? `curso "${cursoTxt}" não cadastrado (use o código ou o título exato)` : 'curso em branco');

      const data = toISO(g('data'));
      if (!data) l.erros.push('data inválida');
      else if (data > hoje) l.erros.push('data futura');

      const notaRaw = g('nota');
      const nota = notaRaw === '' || notaRaw == null ? null : Number(String(notaRaw).replace(',', '.'));
      if (nota != null && (!Number.isFinite(nota) || nota < 0 || nota > 100)) l.erros.push('nota fora de 0–100');
      const cargaRaw = g('carga');
      const carga = cargaRaw === '' || cargaRaw == null ? null : Number(String(cargaRaw).replace(',', '.').replace(/h.*$/i, ''));

      Object.assign(l, {
        colaboradorId: col?.id || null, colaboradorNome: col?.nome || null,
        cursoId: curso?.id || null, cursoCodigo: curso?.codigo || null, data,
        carga: Number.isFinite(carga) ? carga : (curso ? Number(curso.carga_horaria_h) : null),
        instrutor: T(g('instrutor')), modalidade: modalidadeDe(g('modalidade')),
        resultado: resultadoDe(g('resultado')), nota: Number.isFinite(nota) ? nota : null,
        observacao: T(g('observacao'))
      });
      linhas.push(l);
    }

    // Já importado antes? (mesma pessoa + curso + data, origem legado, não anulado)
    const validas = linhas.filter(l => !l.erros.length);
    if (validas.length) {
      const ja = await Pg.connectAndQuery(`
        SELECT r.colaborador_id, r.curso_id, r.data_realizacao::text AS data
          FROM tab_uni_registro r WHERE r.origem = 'legado' AND NOT r.anulado
           AND r.colaborador_id = ANY(@ids::int[])`, { ids: [...new Set(validas.map(l => l.colaboradorId))] });
      const set = new Set(ja.map(x => `${x.colaborador_id}|${x.curso_id}|${x.data}`));
      validas.forEach(l => { if (set.has(`${l.colaboradorId}|${l.cursoId}|${l.data}`)) l.duplicada = true; });
    }
    // duplicada dentro da própria planilha
    const vistos = new Set();
    validas.forEach(l => {
      const k = `${l.colaboradorId}|${l.cursoId}|${l.data}`;
      if (vistos.has(k)) l.duplicada = true; else vistos.add(k);
    });

    const aGravar = validas.filter(l => !l.duplicada);
    const grupos = new Map();
    aGravar.forEach(l => {
      const k = [l.cursoId, l.data, l.instrutor || '', l.modalidade, l.carga ?? ''].join('|');
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(l);
    });

    const resumo = {
      linhas: linhas.length,
      validas: validas.length,
      comErro: linhas.length - validas.length,
      duplicadas: validas.length - aGravar.length,
      aImportar: aGravar.length,
      lotes: grupos.size
    };
    const previa = linhas.slice(0, 500).map(l => ({
      linha: l.linha, nome: l.colaboradorNome || l.nome, curso: l.cursoCodigo || l.cursoTxt, data: l.data,
      modalidade: l.modalidade, resultado: l.resultado, erros: l.erros, duplicada: !!l.duplicada
    }));

    if (dry) return res.json({ ok: true, dry: true, resumo, previa });
    if (!aGravar.length) return res.json({ ok: true, dry: false, resumo, previa, importados: 0 });

    // Versão vigente em cada data (por curso), p/ fixar a revisão do histórico.
    const versoes = await Pg.connectAndQuery(`
      SELECT id, curso_id, vigente_desde::text AS vd FROM tab_uni_curso_versao
       WHERE status <> 'rascunho' AND vigente_desde IS NOT NULL ORDER BY vigente_desde DESC, id DESC`);
    const versaoNa = (cursoId, data) => (versoes.find(v => v.curso_id === cursoId && v.vd <= data) || {}).id || null;

    const nomeArq = String(req.file.originalname || 'planilha').slice(0, 120);
    await Pg.withTransaction(async (cli) => {
      for (const ls of grupos.values()) {
        const p = ls[0];
        const vid = versaoNa(p.cursoId, p.data);
        const lote = await cli.query(`
          INSERT INTO tab_uni_registro_lote (curso_id, versao_id, data_realizacao, carga_h, modalidade, instrutor,
                 verificacao, observacao, origem, criado_por)
          VALUES ($1, $2, $3, $4, $5, $6, 'na', $7, 'legado', $8) RETURNING id`,
          [p.cursoId, vid, p.data, p.carga, p.modalidade, p.instrutor, `Histórico importado de ${nomeArq}`, u.ID || null]);
        await cli.query(`
          INSERT INTO tab_uni_registro (colaborador_id, curso_id, versao_id, lote_id, data_realizacao, carga_h, modalidade,
                 instrutor, origem, verificacao, nota, resultado, observacao, registrado_por)
          SELECT x.colaborador_id, $1, $2, $3, $4, $5, $6, $7, 'legado', 'na', x.nota, x.resultado, x.observacao, $8
            FROM jsonb_to_recordset($9::jsonb) AS x(colaborador_id int, nota numeric, resultado text, observacao text)`,
          [p.cursoId, vid, lote.rows[0].id, p.data, p.carga, p.modalidade, p.instrutor, u.ID || null,
           JSON.stringify(ls.map(l => ({ colaborador_id: l.colaboradorId, nota: l.nota, resultado: l.resultado, observacao: l.observacao })))]);
      }
    });

    await audit(app, req, 'IMPORTAR', 'uni_registro_lote', null,
      `Importou histórico de treinamentos (${nomeArq}): ${aGravar.length} registro(s) em ${grupos.size} lote(s)`, resumo);
    return res.json({ ok: true, dry: false, resumo, previa, importados: aGravar.length });
  }
});

// POST /rh/equipamentos/importar  (multipart: campo 'arquivo' = .xlsx)
// Query: ?dry=true → só valida e devolve preview (não grava).
// Carga em LOTE do parque de equipamentos, vinculando ao colaborador.
// Colunas aceitas (header em qualquer das primeiras 8 linhas, nome flexível):
//   CPF | Matrícula | Nome | Cargo | Marca | Modelo | Cor | IMEI | Nº Série |
//   Data Entrega | Acessórios | Condições
// Resolve o colaborador por CPF; se faltar CPF e houver matrícula, busca no
// Protheus (SRA010). Idempotente por IMEI: linha com IMEI já existente ATUALIZA
// (evita duplicar em re-import); sem IMEI, insere. Perm 1027.

const multer = require('multer');
const ExcelJS = require('exceljs');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const checarPerm = async (Pg, idUser) => {
  const r = await Pg.connectAndQuery(
    `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user=@id AND id_permissao IN (0, 1027) LIMIT 1`, { id: idUser });
  return r.length > 0;
};

const norm = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const cellVal = (cell) => {
  let v = cell ? cell.value : null;
  if (v && typeof v === 'object') {
    if (v instanceof Date) return v;
    if (v.result !== undefined) return v.result;
    if (v.text) return v.text;
    if (v.richText) return v.richText.map(t => t.text).join('');
    return '';
  }
  return v;
};
const T = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };
const toISO = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
};

const ALIAS = {
  documento: ['cpf', 'documento', 'cpf/cnpj', 'cnpj', 'cpf cnpj'],
  matricula: ['matricula', 'mat', 'matr'],
  nome: ['nome', 'colaborador', 'funcionario'],
  cargo: ['cargo', 'funcao'],
  marca: ['marca', 'fabricante'],
  modelo: ['modelo'],
  cor: ['cor'],
  imei: ['imei'],
  serie: ['serie', 'numero de serie', 'n serie', 'ns', 'serial', 'num serie'],
  dataEntrega: ['data entrega', 'data de entrega', 'entrega', 'data'],
  acessorios: ['acessorios', 'acessorio'],
  condicoes: ['condicoes', 'condicao', 'estado', 'condicao do equipamento']
};

function detectarLayout(ws) {
  for (let r = 1; r <= Math.min(ws.rowCount, 8); r++) {
    const row = ws.getRow(r);
    const map = {};
    for (let c = 1; c <= Math.min(ws.columnCount, 30); c++) {
      const h = norm(cellVal(row.getCell(c)));
      if (!h) continue;
      for (const [campo, aliases] of Object.entries(ALIAS)) {
        if (map[campo]) continue;
        if (aliases.some(a => h === a || h.includes(a))) { map[campo] = c; break; }
      }
    }
    // header válido = achou marca/modelo/imei E (documento OU matricula)
    if ((map.marca || map.modelo || map.imei) && (map.documento || map.matricula)) {
      return { headerRow: r, dataInicio: r + 1, map };
    }
  }
  return null;
}

module.exports = (app) => ({
  verb: 'post',
  route: '/equipamentos/importar',
  middlewares: [upload.single('arquivo')],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });
    if (!(await checarPerm(Pg, user.ID))) return res.status(403).json({ message: 'Sem permissão (1027).' });
    if (!req.file || !req.file.buffer) return res.status(400).json({ message: 'Arquivo .xlsx obrigatório (campo "arquivo").' });
    const dry = /^(1|true|sim)$/i.test(String(req.query.dry || ''));

    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer);
      const ws = wb.worksheets[0];
      if (!ws) return res.status(400).json({ message: 'Planilha sem abas.' });
      const layout = detectarLayout(ws);
      if (!layout) return res.status(400).json({ message: 'Não encontrei o cabeçalho. Colunas mínimas: (CPF ou Matrícula) + (Marca/Modelo/IMEI).' });

      const M = layout.map;
      const get = (row, campo) => M[campo] ? T(cellVal(row.getCell(M[campo]))) : null;
      const cacheSra = new Map();

      const linhas = [];
      const erros = [];
      for (let r = layout.dataInicio; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const marca = get(row, 'marca'), modelo = get(row, 'modelo'), imei = soDig(get(row, 'imei')) || null;
        let documento = soDig(get(row, 'documento'));
        let nome = get(row, 'nome');
        let cargo = get(row, 'cargo');
        const matricula = get(row, 'matricula');
        if (!marca && !modelo && !imei && !documento && !matricula) continue;   // linha vazia
        if (!marca && !modelo && !imei) { erros.push({ linha: r, erro: 'sem marca/modelo/IMEI' }); continue; }

        // Resolve colaborador por matrícula no Protheus se faltar CPF
        if (!documento && matricula) {
          const mat = soDig(matricula) || matricula;
          if (cacheSra.has(mat)) { const s = cacheSra.get(mat); documento = s?.cpf || ''; nome = nome || s?.nome; cargo = cargo || s?.cargo; }
          else {
            try {
              const s = await Protheus.connectAndQuery(
                `SELECT TOP 1 RTRIM(RA_CIC) cpf, RTRIM(RA_NOME) nome, RTRIM(RA_CARGO) cargo
                   FROM SRA010 WITH (NOLOCK)
                  WHERE D_E_L_E_T_<>'*' AND RTRIM(RA_MAT)=@m
                    AND RTRIM(COALESCE(RA_SITFOLH,'')) <> 'D'`, { m: mat });
              const hit = s[0] || null; cacheSra.set(mat, hit);
              if (hit) { documento = soDig(hit.cpf); nome = nome || T(hit.nome); cargo = cargo || T(hit.cargo); }
            } catch (e) { /* segue sem SRA */ }
          }
        }

        if (!documento) { erros.push({ linha: r, erro: 'colaborador não resolvido (informe CPF ou matrícula válida)' }); continue; }
        if (!nome) { erros.push({ linha: r, erro: 'nome do colaborador ausente' }); continue; }

        linhas.push({
          linha: r, documento, nome, matricula: matricula ? (soDig(matricula) || matricula) : null, cargo,
          marca, modelo, cor: get(row, 'cor'), imei, numeroSerie: get(row, 'serie'),
          dataEntrega: (M.dataEntrega ? toISO(cellVal(row.getCell(M.dataEntrega))) : null) || new Date().toISOString().slice(0, 10),
          acessorios: get(row, 'acessorios'), condicoes: get(row, 'condicoes')
        });
      }

      if (dry) {
        return res.json({ dry_run: true, layout: { headerRow: layout.headerRow, colunas: Object.keys(M) }, validas: linhas.length, amostra: linhas.slice(0, 8), erros: erros.slice(0, 50) });
      }

      let novos = 0, atualizados = 0;
      for (const l of linhas) {
        try {
          // idempotência por IMEI
          let existe = [];
          if (l.imei) existe = await Pg.connectAndQuery(`SELECT id FROM tab_equipamento_atual WHERE imei=@i LIMIT 1`, { i: l.imei });
          if (existe.length) {
            await Pg.connectAndQuery(`
              UPDATE tab_equipamento_atual SET
                documento=@doc, nome=@nome, matricula_protheus=@mat, cargo=@cargo,
                marca=@marca, modelo=@modelo, cor=@cor, numero_serie=@serie,
                acessorios=@ace, condicoes=@cond, status='ATIVO', atualizado_em=NOW()
               WHERE id=@id`,
              { id: existe[0].id, doc: l.documento, nome: l.nome, mat: l.matricula, cargo: l.cargo,
                marca: l.marca, modelo: l.modelo, cor: l.cor, serie: l.numeroSerie, ace: l.acessorios, cond: l.condicoes });
            atualizados++;
          } else {
            await Pg.connectAndQuery(`
              INSERT INTO tab_equipamento_atual (
                documento, nome, matricula_protheus, cargo,
                marca, modelo, cor, imei, numero_serie, acessorios, condicoes,
                data_entrega, status, registrado_por
              ) VALUES (
                @doc, @nome, @mat, @cargo,
                @marca, @modelo, @cor, @imei, @serie, @ace, @cond,
                @data, 'ATIVO', @uid)`,
              { doc: l.documento, nome: l.nome, mat: l.matricula, cargo: l.cargo,
                marca: l.marca, modelo: l.modelo, cor: l.cor, imei: l.imei, serie: l.numeroSerie,
                ace: l.acessorios, cond: l.condicoes, data: l.dataEntrega, uid: user.ID });
            novos++;
          }
        } catch (e) { erros.push({ linha: l.linha, erro: e.message }); }
      }

      try {
        require('../../services/auditoria').registrar(app, {
          modulo: 'Tecnologia', submodulo: 'Equipamentos', acao: 'IMPORTAR', severidade: 'AVISO',
          req, entidade: 'equipamento', entidadeId: 'lote',
          descricao: `Importou parque de equipamentos: ${novos} novos, ${atualizados} atualizados (IMEI), ${erros.length} erros`
        });
      } catch (e) { /* audit best-effort */ }

      return res.json({ ok: true, novos, atualizados, total: linhas.length, erros: erros.slice(0, 100) });
    } catch (err) {
      console.error('rh/equipamentos/importar:', err.message);
      return res.status(500).json({ message: 'Erro ao importar: ' + err.message });
    }
  }
});

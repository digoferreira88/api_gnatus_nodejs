// services/ciospIngest.js — importa a "MATRIZ CIOSP" (xlsx) para tab_ciosp_venda.
// As 3 abas (EQUIPAMENTOS/DIGITAL/AT) têm as MESMAS 19 colunas; cada aba vira a
// coluna `categoria`. Usado 1x pra semear os dados históricos da planilha e
// reaproveitado pelo endpoint de upload. NÃO toca no Protheus.
//
// ⚠️ Valor: célula numérica do Excel já vem como Number (decimal com "."); só
// string é que precisa de parse BR ("1.234,56"). Tratar os dois.

const ExcelJS = require('exceljs');

// Ordem fixa das colunas na matriz (1-based).
const COL = {
  cliente: 1, cpf: 2, data: 3, vendedor: 4, entrega: 5, uf: 6, pagtoP: 7, pagtoC: 8,
  fin: 9, sitfin: 10, gerente: 11, origem: 12, equipe: 13, valor: 14, tabela: 15,
  equip: 16, obs: 17, obs2: 18, custo: 19
};

// desembrulha valor de célula (fórmula/richText/date/number/string)
function cellVal(cell) {
  let v = cell.value;
  if (v && typeof v === 'object') {
    if (v instanceof Date) return v;
    if (v.result !== undefined) return v.result;
    if (v.text) return v.text;
    if (v.richText) return v.richText.map(t => t.text).join('');
    if (v.hyperlink) return v.text || v.hyperlink;
    return '';
  }
  return v;
}

const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

function parseValor(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  const hasDot = s.includes('.'), hasComma = s.includes(',');
  let n;
  if (hasDot && hasComma) n = Number(s.replace(/\./g, '').replace(',', '.'));   // 1.234,56
  else if (hasComma) n = Number(s.replace(/\./g, '').replace(',', '.'));        // 1234,56
  else n = Number(s.replace(/[^\d.-]/g, ''));                                    // 1234.56 ou 1234
  return Number.isFinite(n) ? n : 0;
}

// Date | 'YYYY-MM-DD' | 'DD/MM/YYYY' -> 'YYYY-MM-DD' | null
function parseData(v) {
  if (!v) return null;
  if (v instanceof Date) {
    // exceljs devolve em UTC; usa componentes UTC pra não escorregar 1 dia
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

const CATS = { EQUIPAMENTOS: 'EQUIPAMENTOS', DIGITAL: 'DIGITAL', AT: 'AT' };

// Lê o arquivo e devolve as linhas normalizadas (sem gravar).
async function lerArquivo(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  return lerWorkbook(wb);
}

// idem, a partir de um Buffer (upload multipart).
async function lerBuffer(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return lerWorkbook(wb);
}

function lerWorkbook(wb) {
  const linhas = [];
  for (const ws of wb.worksheets) {
    const cat = CATS[norm(ws.name).toUpperCase()];
    if (!cat) continue;                          // ignora abas fora do padrão
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cliente = norm(cellVal(row.getCell(COL.cliente)));
      if (!cliente) continue;                    // linha vazia
      linhas.push({
        categoria: cat,
        cliente,
        cpf: norm(cellVal(row.getCell(COL.cpf))).slice(0, 24),
        data: parseData(cellVal(row.getCell(COL.data))),
        vendedor: norm(cellVal(row.getCell(COL.vendedor))).slice(0, 120),
        entrega: norm(cellVal(row.getCell(COL.entrega))).slice(0, 40),
        uf: norm(cellVal(row.getCell(COL.uf))).toUpperCase().slice(0, 4),
        pagtoP: norm(cellVal(row.getCell(COL.pagtoP))).slice(0, 60),
        pagtoC: norm(cellVal(row.getCell(COL.pagtoC))).slice(0, 60),
        fin: norm(cellVal(row.getCell(COL.fin))).slice(0, 80),
        sitfin: norm(cellVal(row.getCell(COL.sitfin))).slice(0, 30),
        gerente: norm(cellVal(row.getCell(COL.gerente))).slice(0, 120),
        origem: norm(cellVal(row.getCell(COL.origem))).slice(0, 20),
        equipe: norm(cellVal(row.getCell(COL.equipe))).slice(0, 120),
        valor: parseValor(cellVal(row.getCell(COL.valor))),
        tabela: norm(cellVal(row.getCell(COL.tabela))).slice(0, 60),
        equip: norm(cellVal(row.getCell(COL.equip))).slice(0, 300),
        obs: norm(cellVal(row.getCell(COL.obs))).slice(0, 300),
        obs2: norm(cellVal(row.getCell(COL.obs2))).slice(0, 300),
        custo: (() => { const c = parseValor(cellVal(row.getCell(COL.custo))); return c > 0 ? c : null; })()
      });
    }
  }
  return linhas;
}

// Importa pro Postgres. Se limpar=true, apaga a edição antes (idempotente p/ re-seed).
async function importar(app, { filePath, buffer, edicao = 'CIOSP 2026', limpar = false, criadoPor = null } = {}) {
  const { Pg } = app.services;
  const linhas = buffer ? await lerBuffer(buffer) : await lerArquivo(filePath);
  if (limpar) await Pg.connectAndQuery(`DELETE FROM tab_ciosp_venda WHERE edicao=@e`, { e: edicao });

  let ins = 0;
  for (const l of linhas) {
    await Pg.connectAndQuery(
      `INSERT INTO tab_ciosp_venda
        (edicao, categoria, cliente, cpf_cnpj, data_venda, vendedor, entrega, uf,
         pagto_princ, pagto_compl, financiadora, situacao_fin, gerente, origem, equipe,
         valor, tabela, equipamentos, observacao, observacao2, custo, criado_por)
       VALUES (@ed,@cat,@cli,@cpf,@data,@vend,@ent,@uf,
               @pp,@pc,@fin,@sit,@ger,@ori,@eq,
               @val,@tab,@equip,@obs,@obs2,@custo,@por)`,
      { ed: edicao, cat: l.categoria, cli: l.cliente, cpf: l.cpf || null, data: l.data,
        vend: l.vendedor || null, ent: l.entrega || null, uf: l.uf || null,
        pp: l.pagtoP || null, pc: l.pagtoC || null, fin: l.fin || null, sit: l.sitfin || null,
        ger: l.gerente || null, ori: l.origem || null, eq: l.equipe || null,
        val: l.valor, tab: l.tabela || null, equip: l.equip || null, obs: l.obs || null,
        obs2: l.obs2 || null, custo: l.custo, por: criadoPor });
    ins++;
  }
  return { importadas: ins, lidas: linhas.length, edicao, limpou: !!limpar };
}

// Normaliza o payload de uma venda vindo da UI -> objeto de params do INSERT/UPDATE.
// Reutilizado pelos endpoints de criar/editar (mesma validação em ambos).
const CATS_VALIDAS = ['EQUIPAMENTOS', 'DIGITAL', 'AT'];
function montarCampos(body = {}) {
  const s = (v, max) => { const t = norm(v); return t ? t.slice(0, max) : null; };
  const categoria = norm(body.categoria).toUpperCase();
  const cliente = norm(body.cliente);
  const erro = !CATS_VALIDAS.includes(categoria) ? 'categoria inválida (EQUIPAMENTOS/DIGITAL/AT)'
    : !cliente ? 'cliente é obrigatório' : null;
  return {
    erro,
    campos: {
      edicao: s(body.edicao, 40) || 'CIOSP 2026',
      categoria, cliente: cliente.slice(0, 200),
      cpf_cnpj: s(body.cpfCnpj, 24), data_venda: parseData(body.dataVenda),
      vendedor: s(body.vendedor, 120), entrega: s(body.entrega, 40), uf: (s(body.uf, 4) || '').toUpperCase() || null,
      pagto_princ: s(body.pagtoPrinc, 60), pagto_compl: s(body.pagtoCompl, 60),
      financiadora: s(body.financiadora, 80), situacao_fin: s(body.situacaoFin, 30),
      gerente: s(body.gerente, 120), origem: s(body.origem, 20), equipe: s(body.equipe, 120),
      valor: parseValor(body.valor), tabela: s(body.tabela, 60), equipamentos: s(body.equipamentos, 300),
      observacao: s(body.observacao, 300), observacao2: s(body.observacao2, 300),
      custo: (() => { const c = parseValor(body.custo); return c > 0 ? c : null; })()
    }
  };
}

module.exports = { importar, lerArquivo, lerBuffer, parseValor, parseData, montarCampos };

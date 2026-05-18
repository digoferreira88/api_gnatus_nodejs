// Importa lead time MANUAL por produto a partir do Excel
// (intra/docs/lead time.xlsx — sheet "Pacote de compras").
//
// Formato esperado:
//   CÒD | DESCRICAO | TIPO | Lead time (mês)
//
// Lead time vem em MESES, convertemos pra DIAS (x 30) e gravamos em
// tab_estoque_produto_meta.lead_time_override.
//
// O dashboard de qualidade ja usa override quando preenchido (prioridade
// sobre B1_PE do Protheus).
//
// Uso:
//   node scripts/import-override-leadtime.js                              # padrao ../docs/
//   node scripts/import-override-leadtime.js /caminho/lead\ time.xlsx     # custom
//   node scripts/import-override-leadtime.js arq.xlsx --dry-run           # so parse
//
// Idempotente. Cria o registro em tab_estoque_produto_meta se nao existir
// (snapshot diario complementa depois com descricao/tipo).

require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const { Pool } = require('pg');

const ARQUIVO_PADRAO = path.resolve(__dirname, '..', '..', 'docs', 'lead time.xlsx');
const SHEET_NOME = 'Pacote de compras';
const BATCH_SIZE = 500;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const arquivoArg = args.find(a => !a.startsWith('--'));
const arquivo = arquivoArg ? path.resolve(arquivoArg) : ARQUIVO_PADRAO;

const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD
});

const parseN = (v) => {
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(/,/g, '.');
  if (!s || s === '-') return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
};

const T = (v) => String(v == null ? '' : v).trim();

async function main() {
  console.log(`Lendo: ${arquivo}${dryRun ? '  (DRY-RUN — nao grava)' : ''}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(arquivo);

  const ws = wb.getWorksheet(SHEET_NOME) || wb.worksheets[0];
  if (!ws) throw new Error(`Sheet "${SHEET_NOME}" nao encontrada`);
  console.log(`Sheet: "${ws.name}" | linhas: ${ws.rowCount}`);

  // Mapeia colunas pelo header — tolerante a variacoes ("CÒD" vs "CÓD")
  const headerRow = ws.getRow(1);
  const idx = {};
  headerRow.eachCell((cell, colNumber) => {
    const k = T(cell.value).toUpperCase().replace(/\s+/g, ' ');
    idx[k] = colNumber;
  });
  const colCod   = idx['CÒD'] || idx['CÓD'] || idx['COD'] || idx['CODIGO'];
  const colDesc  = idx['DESCRICAO'] || idx['DESCRIÇÃO'];
  const colTipo  = idx['TIPO'];
  const colLT    = idx['LEAD TIME (MÊS)'] || idx['LEAD TIME (MES)'] || idx['LEAD TIME'];

  if (!colCod || !colLT) {
    console.error('Colunas detectadas:', Object.keys(idx));
    throw new Error('Colunas obrigatorias nao encontradas (precisa CÒD/CÓD + Lead time)');
  }

  const stats = { lidas: 0, validas: 0, ignoradas: 0, upserts: 0, erros: 0 };
  let lote = [];

  const flush = async () => {
    if (!lote.length || dryRun) { lote = []; return; }
    // Batch UPSERT
    const cols = ['cod_produto', 'tipo_produto', 'descricao', 'lead_time_override'];
    const placeholders = [];
    const values = [];
    lote.forEach((r, i) => {
      const off = i * cols.length;
      placeholders.push(`(${cols.map((_, j) => `$${off + j + 1}`).join(',')})`);
      values.push(r.cod, r.tipo, r.desc, r.leadDias);
    });
    const sql = `
      INSERT INTO tab_estoque_produto_meta (${cols.join(',')})
      VALUES ${placeholders.join(',')}
      ON CONFLICT (cod_produto) DO UPDATE SET
        lead_time_override = EXCLUDED.lead_time_override,
        tipo_produto       = COALESCE(NULLIF(EXCLUDED.tipo_produto, ''), tab_estoque_produto_meta.tipo_produto),
        descricao          = COALESCE(NULLIF(EXCLUDED.descricao, ''),    tab_estoque_produto_meta.descricao),
        manual_em          = NOW()
        -- demanda_mensal_manual e estoque_seguranca_manual NAO mexem
        -- (esse import eh so de lead time)`;
    try {
      await pool.query(sql, values);
      stats.upserts += lote.length;
    } catch (err) {
      console.error(`[batch] erro: ${err.message}. Amostra:`, JSON.stringify(lote[0]).slice(0, 200));
      stats.erros += lote.length;
    }
    lote = [];
  };

  for (let rowNumber = 2; rowNumber <= ws.rowCount; rowNumber++) {
    const row = ws.getRow(rowNumber);
    if (!row || !row.hasValues) continue;
    stats.lidas++;

    const cod  = T(row.getCell(colCod).value);
    const desc = colDesc ? T(row.getCell(colDesc).value).slice(0, 120) : '';
    const tipo = colTipo ? T(row.getCell(colTipo).value).slice(0, 5)  : '';
    const ltMeses = parseN(row.getCell(colLT).value);

    if (!cod || ltMeses == null || ltMeses < 0) {
      stats.ignoradas++;
      if (stats.ignoradas <= 5) {
        console.log(`  ignorada linha ${rowNumber}: cod="${cod}" lt="${row.getCell(colLT).value}"`);
      }
      continue;
    }

    // Lead time em MESES -> DIAS, arredonda. Cap em 365 (validacao do endpoint).
    const leadDias = Math.min(365, Math.max(0, Math.round(ltMeses * 30)));
    stats.validas++;

    lote.push({ cod, tipo, desc, leadDias });
    if (lote.length >= BATCH_SIZE) {
      await flush();
      if (stats.upserts % 2000 === 0 || rowNumber % 5000 === 0) {
        console.log(`  progresso: ${rowNumber}/${ws.rowCount} (${stats.upserts} upserts)`);
      }
    }
  }
  await flush();

  console.log('\n========== RESULTADO ==========');
  console.log(`Linhas lidas:   ${stats.lidas}`);
  console.log(`Linhas validas: ${stats.validas}`);
  console.log(`Ignoradas:      ${stats.ignoradas}`);
  console.log(`Upserts:        ${stats.upserts}${dryRun ? '  (dry-run, nada gravado)' : ''}`);
  console.log(`Erros:          ${stats.erros}`);

  await pool.end();
  process.exit(stats.erros > 0 ? 2 : 0);
}

main().catch(async e => {
  console.error('ERRO fatal:', e.stack || e.message);
  await pool.end();
  process.exit(1);
});

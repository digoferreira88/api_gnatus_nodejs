// Importa historico real de estoque mensal a partir do Excel manual
// (intra/docs/Estoque mensal.xlsx).
//
// Por que: o snapshot diario usa o saldo ATUAL como proxy pros meses
// passados (Protheus nao guarda fechamento historico). O Excel tem o
// fechamento real desde jan/2025. Esse script faz UPSERT preservando os
// dados de SAIDA que ja vem do Protheus — so sobrescreve qtd/valor de
// estoque.
//
// Uso:
//   node scripts/import-snapshot-excel.js                     # arquivo padrao em ../docs/
//   node scripts/import-snapshot-excel.js /caminho/arq.xlsx   # custom
//   node scripts/import-snapshot-excel.js arq.xlsx --dry-run  # so mostra parse, nao grava
//
// Formato esperado do Excel (sheet "empilhado"):
//   CODIGO | TP | GRUPO | DESCRICAO | U.M. | FL | ARMZ |
//   SALDO EM ESTOQUE | EMPENHO ... | ESTOQUE DISPONIVEL |
//   VALOR EM ESTOQUE | VALOR EMPENHADO | DESCRICAO DO ARMAZEM | Data
//
// Idempotente. Pode rodar varias vezes — sempre sobrescreve qtd_estoque,
// valor_estoque, custo_medio e preserva qtd_saidas_mes/valor_saidas_mes.

require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const { Pool } = require('pg');

const ARQUIVO_PADRAO = path.resolve(__dirname, '..', '..', 'docs', 'Estoque mensal.xlsx');
const SHEET_NOME = 'empilhado';
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

// Parse numerico tolerante: " 502.0000 " -> 502, " - " -> 0, null -> 0
const parseN = (v) => {
  if (v == null || v === '') return 0;
  const s = String(v).trim();
  if (!s || s === '-' || s === '–' || s === '—') return 0;
  const cleaned = s.replace(/\s+/g, '').replace(/,/g, '.');
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
};

// "1/31/25" -> "202501"  | "12/30/2024" -> "202412"
const parseAnoMes = (s) => {
  if (!s) return null;
  // ExcelJS pode devolver Date object pra colunas tipadas — trata os 2 casos
  if (s instanceof Date) {
    return `${s.getFullYear()}${String(s.getMonth() + 1).padStart(2, '0')}`;
  }
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const [, mes, , ano] = m;
  const anoFull = ano.length === 2 ? '20' + ano : ano;
  return `${anoFull}${String(mes).padStart(2, '0')}`;
};

const T = (v) => String(v == null ? '' : v).trim();

async function main() {
  console.log(`Lendo: ${arquivo}${dryRun ? '  (DRY-RUN — nao grava)' : ''}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(arquivo);

  const ws = wb.getWorksheet(SHEET_NOME) || wb.worksheets[0];
  if (!ws) throw new Error(`Sheet "${SHEET_NOME}" nao encontrada`);
  console.log(`Sheet: "${ws.name}" | linhas: ${ws.rowCount}`);

  // Le header da linha 1 e mapeia indices
  const headerRow = ws.getRow(1);
  const idx = {};
  headerRow.eachCell((cell, colNumber) => {
    const k = T(cell.value);
    if (k) idx[k] = colNumber;
  });
  const need = ['CODIGO', 'TP', 'GRUPO', 'DESCRICAO', 'ARMZ', 'SALDO EM ESTOQUE', 'VALOR EM ESTOQUE', 'Data'];
  for (const c of need) if (!idx[c]) throw new Error(`Coluna obrigatoria nao encontrada: "${c}"`);

  // Itera linhas, monta lotes, upsert
  const stats = { lidas: 0, validas: 0, ignoradas: 0, upserts: 0, erros: 0, meses: new Set() };
  let lote = [];

  const flush = async () => {
    if (!lote.length || dryRun) { lote = []; return; }
    // Monta INSERT em batch. Cada row vira ($1..$11), depois proxima ($12..$22)...
    const cols = ['ano_mes', 'cod_produto', 'armazem', 'tipo_produto', 'descricao', 'grupo',
                  'qtd_estoque', 'custo_medio', 'valor_estoque', 'qtd_saidas_mes', 'valor_saidas_mes'];
    const placeholders = [];
    const values = [];
    lote.forEach((r, i) => {
      const off = i * cols.length;
      placeholders.push(`(${cols.map((_, j) => `$${off + j + 1}`).join(',')})`);
      values.push(r.ano_mes, r.cod_produto, r.armazem, r.tipo, r.descricao, r.grupo,
                  r.qtd, r.cm, r.valor, 0, 0);
    });
    const sql = `
      INSERT INTO tab_estoque_snapshot_mensal (${cols.join(',')})
      VALUES ${placeholders.join(',')}
      ON CONFLICT (ano_mes, cod_produto, armazem) DO UPDATE SET
        qtd_estoque   = EXCLUDED.qtd_estoque,
        valor_estoque = EXCLUDED.valor_estoque,
        custo_medio   = CASE WHEN EXCLUDED.qtd_estoque > 0
                             THEN EXCLUDED.valor_estoque / EXCLUDED.qtd_estoque
                             ELSE 0 END,
        tipo_produto = COALESCE(NULLIF(EXCLUDED.tipo_produto, ''), tab_estoque_snapshot_mensal.tipo_produto),
        descricao    = COALESCE(NULLIF(EXCLUDED.descricao, ''),    tab_estoque_snapshot_mensal.descricao),
        grupo        = COALESCE(NULLIF(EXCLUDED.grupo, ''),        tab_estoque_snapshot_mensal.grupo),
        snapshot_em  = NOW()
        -- qtd_saidas_mes e valor_saidas_mes NAO mexem (vem do Protheus via cron)`;
    try {
      await pool.query(sql, values);
      stats.upserts += lote.length;
    } catch (err) {
      console.error(`[batch] erro: ${err.message}. Linha amostra:`, JSON.stringify(lote[0]).slice(0, 200));
      stats.erros += lote.length;
    }
    lote = [];
  };

  for (let rowNumber = 2; rowNumber <= ws.rowCount; rowNumber++) {
    const row = ws.getRow(rowNumber);
    if (!row || !row.hasValues) continue;
    stats.lidas++;

    const cod   = T(row.getCell(idx['CODIGO']).value);
    const tipo  = T(row.getCell(idx['TP']).value);
    const grupo = T(row.getCell(idx['GRUPO']).value).slice(0, 10);
    const desc  = T(row.getCell(idx['DESCRICAO']).value).slice(0, 120);
    const armz  = T(row.getCell(idx['ARMZ']).value);
    const qtd   = parseN(row.getCell(idx['SALDO EM ESTOQUE']).value);
    const valor = parseN(row.getCell(idx['VALOR EM ESTOQUE']).value);
    const data  = row.getCell(idx['Data']).value;
    const anoMes = parseAnoMes(data);

    if (!cod || !armz || !anoMes) {
      stats.ignoradas++;
      continue;
    }
    stats.meses.add(anoMes);
    stats.validas++;

    lote.push({
      ano_mes: anoMes,
      cod_produto: cod,
      armazem: armz,
      tipo, descricao: desc, grupo,
      qtd, valor,
      cm: qtd > 0 ? valor / qtd : 0
    });

    if (lote.length >= BATCH_SIZE) {
      await flush();
      if (stats.upserts % 5000 === 0 || rowNumber % 10000 === 0) {
        console.log(`  progresso: ${rowNumber}/${ws.rowCount} (${stats.upserts} upserts)`);
      }
    }
  }
  await flush();

  console.log('\n========== RESULTADO ==========');
  console.log(`Linhas lidas:    ${stats.lidas}`);
  console.log(`Linhas validas:  ${stats.validas}`);
  console.log(`Ignoradas:       ${stats.ignoradas}`);
  console.log(`Upserts:         ${stats.upserts}${dryRun ? '  (dry-run, nada gravado)' : ''}`);
  console.log(`Erros:           ${stats.erros}`);
  console.log(`Meses presentes: ${[...stats.meses].sort().join(', ')}`);

  await pool.end();
  process.exit(stats.erros > 0 ? 2 : 0);
}

main().catch(async e => {
  console.error('ERRO fatal:', e.stack || e.message);
  await pool.end();
  process.exit(1);
});

// Migra os avatares de vendedores ja existentes no filesystem do frontend
// (frontend/public/avatars/vendedores/*.webp | *.png) para a tabela
// tab_vendedor_avatar (BLOB no Postgres).
//
// Idempotente: ON CONFLICT DO NOTHING. Re-rodar nao sobrescreve uploads
// novos feitos via UI. Pra forcar re-import, passe --force.
//
// Uso:
//   node scripts/migrar-avatares-iniciais.js                               # padrao
//   node scripts/migrar-avatares-iniciais.js /caminho/avatars/vendedores   # custom
//   node scripts/migrar-avatares-iniciais.js --force                       # sobrescreve

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const PASTA = args.find(a => !a.startsWith('--'))
  || path.resolve(__dirname, '..', '..', 'frontend', 'public', 'avatars', 'vendedores');

const MIME_BY_EXT = {
  '.webp': 'image/webp',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg'
};

(async () => {
  console.log('Pasta de origem:', PASTA);
  if (!fs.existsSync(PASTA)) {
    console.error('Pasta nao existe:', PASTA);
    process.exit(1);
  }

  const arquivos = fs.readdirSync(PASTA)
    .filter(f => MIME_BY_EXT[path.extname(f).toLowerCase()])
    .filter(f => f !== 'README.md');

  console.log(`Encontrados ${arquivos.length} arquivos de imagem.`);
  if (!arquivos.length) {
    console.log('Nada pra migrar.');
    process.exit(0);
  }

  const pool = new Pool({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT) || 5432,
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD
  });

  const client = await pool.connect();
  try {
    let inseridos = 0, ignorados = 0, sobrescritos = 0, falhas = 0;
    for (const arq of arquivos) {
      const ext = path.extname(arq).toLowerCase();
      const codigo = path.basename(arq, ext).trim();
      const mime = MIME_BY_EXT[ext];
      const fullPath = path.join(PASTA, arq);
      try {
        const buf = fs.readFileSync(fullPath);
        const sql = FORCE
          ? `INSERT INTO tab_vendedor_avatar (codigo, mime_type, tamanho_bytes, bytes)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (codigo) DO UPDATE
               SET mime_type     = EXCLUDED.mime_type,
                   tamanho_bytes = EXCLUDED.tamanho_bytes,
                   bytes         = EXCLUDED.bytes,
                   atualizado_em = NOW()
             RETURNING (xmax = 0) AS inserido`
          : `INSERT INTO tab_vendedor_avatar (codigo, mime_type, tamanho_bytes, bytes)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (codigo) DO NOTHING
             RETURNING codigo`;
        const r = await client.query(sql, [codigo, mime, buf.length, buf]);
        if (FORCE) {
          if (r.rows[0]?.inserido) inseridos++;
          else sobrescritos++;
        } else {
          if (r.rows.length) inseridos++;
          else ignorados++;
        }
      } catch (e) {
        falhas++;
        console.error('Falha em', arq, '-', e.message);
      }
    }
    console.log(`\nResumo: ${inseridos} inseridos, ${sobrescritos} sobrescritos, ${ignorados} ignorados (ja existiam), ${falhas} falhas.`);
  } finally {
    client.release();
    await pool.end();
  }
})().catch(e => { console.error('ERRO:', e); process.exit(1); });

// Itera todos os anexos origem='sharepoint' do PG e tenta fazer
// check-in/publish em cada um. Resolve o caso dos anexos antigos que
// ficaram em rascunho no SharePoint (invisiveis pra outros usuarios)
// porque a biblioteca exige check-out.
//
// Uso:
//   sudo -u intranet bash -c "cd /home/intranet/backend && node scripts/publicar-anexos-sp.js"
//
// Idempotente — pode rodar varias vezes sem efeito colateral. 4xx no
// publish/checkin sao normais (arquivo ja publicado).

require('dotenv').config();
const Graph = require('../services/graphFiles');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD
});

(async () => {
  const r = await pool.query(`
    SELECT id, registro_id, titulo, sharepoint_drive_id, sharepoint_item_id, sharepoint_path
      FROM tab_prod_registro_anexo
     WHERE origem = 'sharepoint'
       AND sharepoint_drive_id IS NOT NULL
       AND sharepoint_item_id IS NOT NULL
     ORDER BY id`
  );

  console.log(`Encontrei ${r.rows.length} anexos SharePoint pra processar.\n`);

  let okCount = 0;
  let warnCount = 0;
  let errCount = 0;

  for (const a of r.rows) {
    process.stdout.write(`#${a.id} ${a.titulo.slice(0, 50).padEnd(50)} ... `);
    try {
      const res = await Graph.publishItem(a.sharepoint_drive_id, a.sharepoint_item_id);
      const houveOk = Object.values(res).some(v => v === 'ok');
      if (houveOk) {
        console.log('OK');
        okCount++;
      } else {
        console.log('WARN', JSON.stringify(res));
        warnCount++;
      }
    } catch (e) {
      console.log('ERRO', e.message);
      errCount++;
    }
  }

  console.log(`\nResumo: ${okCount} publicados · ${warnCount} ja-publicado/sem-versao · ${errCount} erros`);
  await pool.end();
  process.exit(0);
})().catch(async e => {
  console.error('ERRO fatal:', e.message);
  await pool.end();
  process.exit(1);
});

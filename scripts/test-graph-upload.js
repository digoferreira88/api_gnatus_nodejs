// Valida o servico Graph (services/graphFiles.js) end-to-end:
//   1. Obtem token + descobre drive id da conta GRAPH_STORAGE_UPN
//   2. Faz upload de arquivo TXT pequeno na pasta "Pipefy compartilhada/Producao Intranet/_teste/"
//   3. Pega download URL e baixa de volta pra confirmar conteudo identico
//   4. Apaga o arquivo
//
// Uso:
//   cd /home/intranet/backend
//   node scripts/test-graph-upload.js
//
// Em caso de falha mostra response.data do Graph pra facilitar debug
// (codigo de erro como `accessDenied`, `itemNotFound` etc).

require('dotenv').config();
const Graph = require('../services/graphFiles');

const linha = (s = '') => console.log(`\n----- ${s} -----`);

(async () => {
  linha('1. Test connection / drive discovery');
  const conn = await Graph.testConnection();
  console.log(conn);
  if (!conn.ok) {
    console.error('Falhou na conexao. Verifique:');
    console.error('  - M365_TENANT_ID/CLIENT_ID/CLIENT_SECRET no .env');
    console.error('  - Permission "Files.ReadWrite.All" (Application) com admin consent no app registration');
    console.error(`  - Conta ${Graph.STORAGE_UPN} existe e tem licenca M365 (OneDrive)`);
    process.exit(1);
  }

  const conteudoOriginal = `Teste graphFiles.js — ${new Date().toISOString()}\nbytes aleatorios: ${Math.random()}`;
  const buf = Buffer.from(conteudoOriginal, 'utf8');
  const path = `Pipefy compartilhada/Producao Intranet/_teste/test-${Date.now()}.txt`;

  linha(`2. Upload "${path}" (${buf.length} bytes)`);
  let up;
  try {
    up = await Graph.uploadFile({ path, buffer: buf, mime: 'text/plain' });
    console.log(up);
  } catch (e) {
    console.error('Falhou upload:', e.response?.data || e.message);
    process.exit(1);
  }

  linha('3. Download URL + baixar pra conferir');
  const dl = await Graph.getDownloadUrl({ drive_id: up.drive_id, item_id: up.item_id });
  console.log({ name: dl.name, size: dl.size, mime: dl.mime, url_inicio: dl.url.slice(0, 80) + '...' });

  // Baixa e compara conteudo
  const r = await fetch(dl.url);
  const baixado = await r.text();
  if (baixado === conteudoOriginal) {
    console.log('OK conteudo baixado bate com original.');
  } else {
    console.error('FALHA conteudo divergente!');
    console.error('  original:', JSON.stringify(conteudoOriginal));
    console.error('  baixado :', JSON.stringify(baixado));
  }

  linha('4. Delete');
  try {
    const del = await Graph.deleteFile({ drive_id: up.drive_id, item_id: up.item_id });
    console.log(del);
  } catch (e) {
    console.error('Falhou delete:', e.response?.data || e.message);
    process.exit(1);
  }

  linha('FIM — tudo OK');
  process.exit(0);
})().catch(e => {
  console.error('ERRO inesperado:', e.response?.data || e.message);
  process.exit(1);
});

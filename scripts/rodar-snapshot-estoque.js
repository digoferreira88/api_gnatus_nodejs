// Roda o snapshot de estoque manualmente (bootstrap dos N meses).
// Uso:
//   node scripts/rodar-snapshot-estoque.js [meses=12]
//   ex: node scripts/rodar-snapshot-estoque.js 12

require('dotenv').config();
const Pg = require('../services/pg');
const Protheus = require('../services/protheus');
const EstoqueSnapshot = require('../services/estoqueSnapshot');

const meses = Math.min(Math.max(Number(process.argv[2]) || 12, 1), 24);

(async () => {
  console.log(`Iniciando snapshot de ${meses} meses...`);
  const stats = await EstoqueSnapshot.atualizar({ services: { Pg, Protheus } }, { meses });
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
})().catch(err => {
  console.error('ERRO:', err.message);
  process.exit(1);
});

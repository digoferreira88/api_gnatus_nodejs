// Gera e publica o espelho do portal do cliente, sem passar pela tela.
// Uso:
//   node scripts/portal-publicar.js            # monta, grava e publica
//   node scripts/portal-publicar.js --so-pdf   # so manda os PDFs que faltam
//
// A rodada completa varre ~40 mil titulos no Protheus; o --so-pdf serve pra
// drenar a fila de PDFs (PORTAL_PDFS_POR_RODADA por vez) sem refazer isso.

require('dotenv').config();
const Pg = require('../services/pg');
const Protheus = require('../services/protheus');
const Espelho = require('../services/portalEspelho');

const app = { services: { Pg, Protheus } };
const soPdf = process.argv.includes('--so-pdf');

(async () => {
  const r = soPdf ? await Espelho.publicar(app) : await Espelho.rodar(app, { por: null });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.erro ? 1 : 0);
})().catch(err => {
  console.error('ERRO:', err.message);
  process.exit(1);
});

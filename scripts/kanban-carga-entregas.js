// Carga inicial das entregas da Datafrete para o Kanban de Pedidos.
//
// O scheduler só olha os últimos 7 dias. Sem esta carga, pedidos do período padrão
// (90 dias) entregues há mais tempo ficariam presos em "Em transporte" com SLA
// estourado. Só LEITURA na Datafrete (GET /ocorrencias), fatiado em blocos de 5 dias.
//
// Uso (na pasta do backend):  node scripts/kanban-carga-entregas.js [dias=120]
// Pode rodar de novo sem problema: grava por chave da NF e entrega nunca "desentrega".

require('dotenv').config();
const path = require('path');

(async () => {
  const dias = Math.min(400, Math.max(1, Number(process.argv[2]) || 120));
  const app = {};
  app.services = require('../config/loader')(path.join(__dirname, '..', 'services'), app);
  const Kanban = require('../services/kanbanPedidos');

  const fim = new Date();
  // Em blocos de 30 dias, para uma falha no meio não perder tudo o que já veio.
  let total = { nfs: 0, entregues: 0, eventos: 0 };
  for (let desde = dias; desde > 0; desde -= 30) {
    const ini = new Date(fim.getTime() - (desde - 1) * 864e5);
    const ate = new Date(fim.getTime() - Math.max(0, desde - 30) * 864e5);
    const t0 = Date.now();
    const r = await Kanban.sincronizarEntregas(app, { inicio: ini, fim: ate });
    if (!r.ok) { console.error(`  falhou em ${ini.toISOString().slice(0, 10)}..${ate.toISOString().slice(0, 10)}: ${r.motivo}`); process.exit(1); }
    total.nfs += r.nfs; total.entregues += r.entregues; total.eventos += r.eventos;
    console.log(`  ${ini.toISOString().slice(0, 10)} a ${ate.toISOString().slice(0, 10)}: ${r.eventos} eventos, ${r.nfs} NFs, ${r.entregues} entregues (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  console.log(`  total: ${total.eventos} eventos, ${total.nfs} NFs gravadas, ${total.entregues} entregues`);
  process.exit(0);
})();

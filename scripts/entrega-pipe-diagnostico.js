// scripts/entrega-pipe-diagnostico.js — confere, SÓ LENDO, se o robô de entrega
// (services/pipefyGarantia.js) enxerga um card do jeito que precisa: fase atual,
// número da NF, etiquetas do card e do pipe, NF na SF2 e ocorrência no Datafrete.
// Não move nem altera nada. 2 chamadas ao Pipefy por execução.
//
// Uso (na pasta do backend):  node scripts/entrega-pipe-diagnostico.js <cardId> [chave do robô]
//   ex.: node scripts/entrega-pipe-diagnostico.js 1465997641 pipe304879138
require('dotenv').config({ quiet: true });
const Robo = require('../services/pipefyGarantia');
const Datafrete = require('../services/datafreteTms');

const cardId = process.argv[2];
const robo = Robo.ROBOS.find(r => r.chave === (process.argv[3] || 'pipe304879138'));
if (!cardId || !robo) { console.log('uso: node scripts/entrega-pipe-diagnostico.js <cardId> [garantia|pipe304879138]'); process.exit(1); }

const gql = async (query) => {
  const r = await fetch('https://api.pipefy.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(process.env.PIPEFY_TOKEN || '').trim()}` },
    body: JSON.stringify({ query })
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map(e => e.message).join('; '));
  return j.data;
};
const ok = (cond) => (cond ? 'OK ' : '!! ');

(async () => {
  const { card } = await gql(`{ card(id: ${Number(cardId)}) { id title pipe { id name } current_phase { id name }
    labels { id name } fields { name value field { id } } } }`);
  const { pipe } = await gql(`{ pipe(id: ${Number(robo.pipeId)}) { name labels { id name } phases { id name } } }`);

  console.log(`Card ${card.id} — ${card.title}`);
  console.log(`${ok(String(card.pipe.id) === robo.pipeId)}pipe: ${card.pipe.name} (${card.pipe.id})`);
  console.log(`${ok(String(card.current_phase.id) === robo.faseOrigem)}fase atual: ${card.current_phase.name} (${card.current_phase.id}) — o robô só olha a ${robo.faseOrigem}`);
  const destino = pipe.phases.find(p => String(p.id) === robo.faseDestino);
  console.log(`${ok(!!destino)}fase de destino ${robo.faseDestino}: ${destino ? destino.name : 'NÃO EXISTE no pipe'}`);

  const nf = Robo.campoDoCard(card, robo.campoNf).replace(/\D/g, '');
  console.log(`${ok(!!nf)}NF lida do card: ${nf || '(vazia)'}`);
  if (!nf) {
    console.log('   campos que parecem NF (rótulo | id | valor):');
    card.fields.filter(f => /n[uú]mero|nota|nf/i.test(f.name)).forEach(f => console.log(`     ${f.name} | ${f.field.id} | ${f.value}`));
  }

  if (robo.etiquetas) {
    const tem = (lista, nome) => lista.some(l => Robo.norm(l.name) === Robo.norm(nome));
    console.log(`   etiquetas do card: ${card.labels.map(l => l.name).join(', ') || '(nenhuma)'}`);
    console.log(`${ok(tem(pipe.labels, robo.etiquetas.adicionar))}etiqueta "${robo.etiquetas.adicionar}" existe no pipe`);
    console.log(`${ok(tem(pipe.labels, robo.etiquetas.remover))}etiqueta "${robo.etiquetas.remover}" existe no pipe`);
    console.log(`   etiquetas do pipe: ${pipe.labels.map(l => l.name).join(', ')}`);
  }

  if (nf && Datafrete.disponivel()) {
    const dias = Math.max(1, Number(process.env.DATAFRETE_OCO_JANELA_DIAS || 7));
    const oco = await Datafrete.consultarOcorrencias({ dias });
    if (!oco.ok) return console.log(`!! Datafrete HTTP ${oco.http}: ${oco.txt}`);
    const m = Datafrete.extrairEntregas(oco.eventos).find(e => e.numeroNf.replace(/^0+/, '') === nf.replace(/^0+/, ''));
    console.log(m
      ? `   Datafrete (${dias}d, por número — o robô confere também a chave da SF2): ${m.entregue ? 'ENTREGUE' : 'em trânsito'} — ${m.descricao} (${m.dtEvento})`
      : `   Datafrete: sem ocorrência da NF nos últimos ${dias} dias`);
  }
})().catch(e => { console.error('FALHA:', e.message); process.exit(1); });

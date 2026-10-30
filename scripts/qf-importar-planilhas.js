#!/usr/bin/env node
// Importa as planilhas da Qualidade para o módulo de Qualificação de Fornecedores.
//
//   node scripts/qf-importar-planilhas.js --lista "<FORM 7.3.24.xlsx>" --inspecoes "<FORM 7.4.3.H.xlsx>"          (simulação)
//   node scripts/qf-importar-planilhas.js --lista "<...>" --inspecoes "<...>" --gravar                           (grava)
//   ... --gravar --sincronizar-sa2   (depois de gravar, completa nacional/importado, CNPJ e UF pela SA2)
//
// Ordem: primeiro a lista (criticidade/SGQ), depois as inspeções (IQF). Sem
// --gravar nada é escrito — só o relatório. A mesma rotina está na tela
// Configuração → Importação (perm 23006).

process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config();
const fs = require('fs');
const Pg = require('../services/pg');
const Imp = require('../services/qfImport');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const gravar = process.argv.includes('--gravar');
const app = { services: { Pg } };

(async () => {
  const lista = arg('--lista'), insp = arg('--inspecoes');
  if (!lista && !insp) {
    console.log('Uso: node scripts/qf-importar-planilhas.js --lista <7.3.24.xlsx> --inspecoes <7.4.3.H.xlsx> [--gravar]');
    process.exit(1);
  }
  console.log(gravar ? '>> GRAVANDO no banco' : '>> SIMULAÇÃO (use --gravar para gravar)');
  try {
    if (lista) {
      const r = await Imp.importarLista(app, fs.readFileSync(lista), { dryRun: !gravar });
      console.log('\n=== FORM 7.3.24 ===');
      console.log(JSON.stringify({ ...r, comAvisos: `${r.comAvisos.length} fornecedores (detalhe abaixo)` }, null, 2));
      r.comAvisos.forEach(a => console.log(`  ${a.codigo} ${a.nome} [${a.criticidade}]: ${a.avisos.join('; ')}`));
    }
    if (insp) {
      const r = await Imp.importarInspecoes(app, fs.readFileSync(insp), { dryRun: !gravar });
      console.log('\n=== FORM 7.4.3.H ===');
      console.log(JSON.stringify(r, null, 2));
      if (r.conferencia) console.log(r.conferencia.infitekOk ? '\nVALIDAÇÃO INFITEK (003794): OK — 14 inspeções, IQF 10,2857, classe A' : '\nVALIDAÇÃO INFITEK (003794): FALHOU');
    }
    // A planilha não diz se o fornecedor é importado (o P do importado é pela data de
    // COLETA) nem traz CNPJ/UF: a SA2 completa isso.
    if (gravar && process.argv.includes('--sincronizar-sa2')) {
      app.services.Protheus = require('../services/protheus');
      const Core = require('../services/qfCore');
      const r = await Core.sincronizarSA2(app);
      console.log('\n=== Sincronização com o Protheus (SA2) ===');
      console.log(JSON.stringify(r, null, 2));
    }
  } catch (e) {
    console.error('ERRO:', e.message);
    process.exitCode = 1;
  } finally {
    await Pg.pool.end();
  }
})();

// Diagnostico fundo da conta pipefy@gnatus.com.br pra entender por que o
// /users/{id}/drive volta 404 mesmo o Zapier usando o OneDrive dela hoje.
//
// Tenta 4 caminhos:
//   1. /users/{id}/licenseDetails        — confirma se tem licenca com OneDrive
//   2. /users/{id}/drives                — lista todos os drives (plural)
//   3. /sites/{hostname}:/personal/...   — personal site direto via path
//   4. /sites/{siteId}/drives            — drives do personal site
//
// Output mostra qual caminho funciona — usaremos esse no graphFiles.js.

require('dotenv').config();
const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');
const { ConfidentialClientApplication } = require('@azure/msal-node');

const UPN = process.env.GRAPH_STORAGE_UPN || 'pipefy@gnatus.com.br';
// Site pessoal eh: {tenant}-my.sharepoint.com/personal/{upn-com-underscores}
const TENANT_PREFIX = process.env.SPO_TENANT_PREFIX || 'gnatus';   // gnatus.sharepoint.com / gnatus-my.sharepoint.com
const SITE_HOSTNAME = `${TENANT_PREFIX}-my.sharepoint.com`;
const PERSONAL_PATH = `/personal/${UPN.replace(/@/g, '_').replace(/\./g, '_')}`;

const linha = (s) => console.log(`\n========== ${s} ==========`);

(async () => {
  const msal = new ConfidentialClientApplication({
    auth: {
      clientId: process.env.M365_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${process.env.M365_TENANT_ID}`,
      clientSecret: process.env.M365_CLIENT_SECRET
    }
  });
  const r = await msal.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
  const c = Client.init({ authProvider: (done) => done(null, r.accessToken), defaultVersion: 'v1.0' });

  console.log(`UPN:           ${UPN}`);
  console.log(`Site hostname: ${SITE_HOSTNAME}`);
  console.log(`Personal path: ${PERSONAL_PATH}`);

  // 1. Licencas
  linha('1. /users/{upn}/licenseDetails');
  try {
    const lic = await c.api(`/users/${encodeURIComponent(UPN)}/licenseDetails`).get();
    if (!lic.value?.length) {
      console.log('Sem licencas atribuidas — OneDrive nao sera provisionado.');
    } else {
      lic.value.forEach(l => {
        const planos = (l.servicePlans || []).map(sp => `${sp.servicePlanName}=${sp.provisioningStatus}`).join(', ');
        console.log(`SKU ${l.skuPartNumber}`);
        console.log(`   planos: ${planos.slice(0, 300)}`);
      });
      const temSpo = lic.value.some(l =>
        (l.servicePlans || []).some(sp => /SHAREPOINT|OFFICESUBSCRIPTION_S_TEAMS|ONEDRIVE/i.test(sp.servicePlanName)
          && sp.provisioningStatus === 'Success')
      );
      console.log(temSpo ? 'OK tem plano SharePoint/OneDrive provisionado' : 'ALERTA SharePoint/OneDrive NAO provisionado');
    }
  } catch (e) {
    console.log('Erro:', e.statusCode, e.message);
  }

  // 2. /users/{upn}/drives (plural)
  linha('2. /users/{upn}/drives  (plural)');
  try {
    const d = await c.api(`/users/${encodeURIComponent(UPN)}/drives`).get();
    if (!d.value?.length) {
      console.log('Nenhum drive associado.');
    } else {
      d.value.forEach(dr => console.log(`  ${dr.driveType}  id=${dr.id}  name=${dr.name}`));
    }
  } catch (e) {
    console.log('Erro:', e.statusCode, e.message);
  }

  // 3. Personal site via path
  linha(`3. /sites/${SITE_HOSTNAME}:${PERSONAL_PATH}`);
  let siteId = null;
  try {
    const s = await c.api(`/sites/${SITE_HOSTNAME}:${PERSONAL_PATH}`).get();
    siteId = s.id;
    console.log('  id:          ', s.id);
    console.log('  displayName: ', s.displayName);
    console.log('  webUrl:      ', s.webUrl);
  } catch (e) {
    console.log('Erro:', e.statusCode, e.message);
  }

  // 4. Drives do personal site (plural)
  if (siteId) {
    linha(`4. /sites/{siteId}/drives  (plural)`);
    try {
      const dlist = await c.api(`/sites/${siteId}/drives`).get();
      if (!dlist.value?.length) {
        console.log('  (vazio — provavel falta de Sites.ReadWrite.All ou personal site sem drives expostos a app)');
      }
      dlist.value.forEach(dr => {
        console.log(`  ${dr.driveType}  id=${dr.id}  name=${dr.name}  webUrl=${dr.webUrl}`);
      });
    } catch (e) {
      console.log('Erro:', e.statusCode, e.message);
    }

    // 5. /sites/{siteId}/drive singular (default drive)
    linha(`5. /sites/{siteId}/drive  (singular — default)`);
    let defaultDriveId = null;
    try {
      const d = await c.api(`/sites/${siteId}/drive`).get();
      defaultDriveId = d.id;
      console.log(`  id:       ${d.id}`);
      console.log(`  type:     ${d.driveType}`);
      console.log(`  name:     ${d.name}`);
      console.log(`  webUrl:   ${d.webUrl}`);
    } catch (e) {
      console.log('Erro:', e.statusCode, e.message);
      if (e.body) try { console.log('  body:', JSON.parse(e.body).error); } catch {}
    }

    // 6. Lists do site (Documents library = drive primario)
    linha(`6. /sites/{siteId}/lists  (bibliotecas e listas)`);
    try {
      const ls = await c.api(`/sites/${siteId}/lists`)
        .select('id,displayName,name,webUrl,list')
        .get();
      ls.value.forEach(l => {
        console.log(`  ${l.list?.template || '-'.padEnd(15)}  "${l.displayName}"  name=${l.name}`);
      });
    } catch (e) {
      console.log('Erro:', e.statusCode, e.message);
    }

    // 7. Se temos drive id, lista root
    if (defaultDriveId) {
      linha(`7. /drives/{driveId}/root/children  (top-level)`);
      try {
        const ch = await c.api(`/drives/${defaultDriveId}/root/children`).select('name,folder,file').top(30).get();
        if (!ch.value?.length) console.log('  (raiz vazia)');
        ch.value.forEach(it => {
          const tipo = it.folder ? 'DIR ' : 'FILE';
          console.log(`  ${tipo}  ${it.name}`);
        });
      } catch (e) {
        console.log('Erro:', e.statusCode, e.message);
      }

      // 8. Tenta acessar a pasta "Pipefy compartilhada" direto
      linha(`8. /drives/{driveId}/root:/Pipefy compartilhada`);
      try {
        const p = await c.api(`/drives/${defaultDriveId}/root:/Pipefy%20compartilhada`)
          .select('id,name,folder,webUrl,parentReference').get();
        console.log(`  id:     ${p.id}`);
        console.log(`  folder: child=${p.folder?.childCount}`);
        console.log(`  webUrl: ${p.webUrl}`);
      } catch (e) {
        console.log('Erro:', e.statusCode, e.message);
      }
    }
  }

  linha('FIM');
  process.exit(0);
})().catch(e => {
  console.error('ERRO:', e.statusCode || '', e.message);
  if (e.body) try { console.error(JSON.parse(e.body)); } catch { console.error(e.body); }
  process.exit(1);
});

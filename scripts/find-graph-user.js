// Acha um user M365 pelo prefix do email/UPN/displayName e mostra se tem
// OneDrive provisionado.
//
// Uso:
//   node scripts/find-graph-user.js pipefy
//   node scripts/find-graph-user.js rodrigo
//
// Util quando o UPN canonico difere do email amigavel — ex: a conta usa
// "pipefy@gnatus.onmicrosoft.com" mas o email visivel eh "pipefy@gnatus.com.br".
// O Graph (app permission) so encontra pelo UPN canonico ou ID.

require('dotenv').config();
const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');
const { ConfidentialClientApplication } = require('@azure/msal-node');

const q = String(process.argv[2] || '').trim();
if (!q) { console.error('Uso: node scripts/find-graph-user.js <prefix>'); process.exit(1); }

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

  console.log(`Buscando users com prefix "${q}"...\n`);

  // Filtra em mail / UPN / displayName / mailNickname
  const filter = `startswith(mail,'${q}') or startswith(userPrincipalName,'${q}') or startswith(displayName,'${q}') or startswith(mailNickname,'${q}')`;
  const list = await c.api('/users')
    .filter(filter)
    .select('id,displayName,userPrincipalName,mail,mailNickname,accountEnabled')
    .top(25)
    .get();

  if (!list.value?.length) {
    console.log('Nenhum user encontrado.');
    process.exit(0);
  }

  for (const u of list.value) {
    console.log(`--- ${u.displayName} ---`);
    console.log(`  id:       ${u.id}`);
    console.log(`  upn:      ${u.userPrincipalName}`);
    console.log(`  mail:     ${u.mail || '(sem mail)'}`);
    console.log(`  nickname: ${u.mailNickname || '(sem nickname)'}`);
    console.log(`  ativo:    ${u.accountEnabled}`);

    // Tenta drive
    try {
      const d = await c.api(`/users/${u.id}/drive`).select('id,driveType,owner').get();
      console.log(`  drive:    OK  driveType=${d.driveType}  drive_id=${d.id}`);
    } catch (e) {
      console.log(`  drive:    SEM  (${e.statusCode || ''} ${e.message?.slice(0, 80) || ''})`);
    }
    console.log();
  }
  process.exit(0);
})().catch(e => {
  console.error('ERRO:', e.statusCode || '', e.message);
  if (e.body) try { console.error(JSON.parse(e.body)); } catch { console.error(e.body); }
  process.exit(1);
});

// scripts/validar-migracao.js
// Checklist de pós-migração da VPS (novo IP). Valida, em segundos, todas as
// dependências que dependem do IP — principalmente as de SAÍDA que passam pelo
// FortiGate da Gnatus (SQL Server, REST Protheus, AD LDAPS).
//
// Uso (a partir da pasta do backend, p/ achar node_modules e .env):
//   cd /home/intranet/backend && node scripts/validar-migracao.js
//
// Não escreve nada nem altera estado: só conecta/consulta e reporta verde/vermelho.
// Sai com código != 0 se algum item CRÍTICO falhar (útil pra automação).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const net = require('net');
const tls = require('tls');

// ---- saída bonita ----
const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m' };
const ok = (s) => `${C.green}✔ ${s}${C.reset}`;
const fail = (s) => `${C.red}✘ ${s}${C.reset}`;
const warn = (s) => `${C.yellow}▲ ${s}${C.reset}`;
const ms = () => process.hrtime.bigint();
const dur = (t0) => `${Number(ms() - t0) / 1e6 | 0}ms`;

const resultados = [];
function reg(nome, critico, passou, detalhe, t0) {
  resultados.push({ nome, critico, passou, detalhe, tempo: t0 ? dur(t0) : '' });
  const tag = passou ? ok(nome) : (critico ? fail(nome) : warn(nome));
  const tempo = t0 ? `${C.dim}(${dur(t0)})${C.reset}` : '';
  console.log(`  ${tag} ${tempo}\n      ${C.dim}${detalhe}${C.reset}`);
}

// ---- helper: conexão TCP crua (prova caminho liberado no firewall) ----
function tcpProbe(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (okConn, msg) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve({ ok: okConn, msg }); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => fin(true, `porta ${port} acessível`));
    s.once('timeout', () => fin(false, `timeout (${timeoutMs}ms) — firewall bloqueando ${host}:${port}?`));
    s.once('error', (e) => fin(false, `${e.code || e.message} em ${host}:${port}`));
    s.connect(port, host);
  });
}
function tlsProbe(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (okConn, msg) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve({ ok: okConn, msg }); };
    const sock = tls.connect({ host, port, rejectUnauthorized: false, timeout: timeoutMs }, () => fin(true, `handshake TLS ok em ${host}:${port}`));
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => fin(false, `timeout (${timeoutMs}ms) — firewall bloqueando ${host}:${port}?`));
    sock.once('error', (e) => fin(false, `${e.code || e.message} em ${host}:${port}`));
  });
}
function parseHostPort(url, portoPadrao) {
  try { const u = new URL(url); return { host: u.hostname, port: Number(u.port) || portoPadrao }; }
  catch { return null; }
}

(async () => {
  console.log(`\n${C.bold}${C.cyan}═══ Validação pós-migração da VPS ═══${C.reset}\n`);

  // 0) IP público de saída (confirma o IP novo)
  {
    const t0 = ms();
    try {
      const axios = require('axios');
      const { data } = await axios.get('https://api.ipify.org', { timeout: 8000 });
      reg('IP público de SAÍDA', false, true, `egress atual: ${C.bold}${String(data).trim()}${C.reset}${C.dim} — é o IP novo? confirme no FortiGate/Cloudflare`, t0);
    } catch (e) { reg('IP público de SAÍDA', false, false, `não consegui consultar ipify: ${e.message}`, t0); }
  }

  console.log(`\n${C.bold}— Saída pela rede Gnatus (FortiGate) — os mais críticos —${C.reset}`);

  // 1) SQL Server Protheus (1433) — connect + SELECT 1
  {
    const t0 = ms();
    const server = process.env.PROTHEUS_SERVER;
    try {
      const sql = require('mssql');
      const pool = await new sql.ConnectionPool({
        user: process.env.PROTHEUS_USER, password: process.env.PROTHEUS_PASSWORD,
        server, database: process.env.PROTHEUS_DATABASE || 'protheus',
        options: { encrypt: false, trustServerCertificate: true },
        connectionTimeout: 12000, requestTimeout: 12000
      }).connect();
      const r = await pool.request().query('SELECT 1 AS ok');
      await pool.close();
      reg('SQL Server Protheus (1433)', true, r.recordset[0].ok === 1, `${server} respondeu SELECT 1 — login e dashboards OK`, t0);
    } catch (e) {
      // se o connect falhar, faz um probe TCP cru pra distinguir "firewall" de "credencial"
      const probe = await tcpProbe(server, 1433);
      const dica = probe.ok ? 'porta abre mas conexão falhou (credencial/instância?)' : 'porta NÃO abre → liberar IP novo no FortiGate (1433)';
      reg('SQL Server Protheus (1433)', true, false, `${e.message} · ${dica}`, t0);
    }
  }

  // 2) REST Protheus (8081)
  {
    const t0 = ms();
    const url = process.env.PROTHEUS_API_URL;
    const hp = parseHostPort(url, 8081);
    if (!url || !hp) { reg('REST Protheus (8081)', true, false, 'PROTHEUS_API_URL não configurado', t0); }
    else {
      try {
        const axios = require('axios');
        const resp = await axios.get(url, { timeout: 8000, validateStatus: () => true });
        // qualquer resposta HTTP (200/401/404) prova que o caminho está aberto
        reg('REST Protheus (8081)', true, true, `${hp.host}:${hp.port} respondeu HTTP ${resp.status} — aprovações/criação de SC OK`, t0);
      } catch (e) {
        const probe = await tcpProbe(hp.host, hp.port);
        const dica = probe.ok ? 'porta abre mas HTTP falhou' : 'porta NÃO abre → liberar IP novo no FortiGate (8081)';
        reg('REST Protheus (8081)', true, false, `${e.code || e.message} · ${dica}`, t0);
      }
    }
  }

  // 3) Active Directory LDAPS
  {
    const t0 = ms();
    const hp = parseHostPort(process.env.AD_URL, 636);
    if (!hp) { reg('Active Directory LDAPS', true, false, 'AD_URL não configurado', t0); }
    else {
      // tenta bind real com ldapts (valida ponta-a-ponta); cai pra TLS probe se faltar lib/cred
      let validou = false, detalhe = '';
      try {
        const { Client } = require('ldapts');
        const client = new Client({ url: process.env.AD_URL, tlsOptions: { rejectUnauthorized: false }, timeout: 8000, connectTimeout: 8000 });
        await client.bind(process.env.AD_BIND_USER, process.env.AD_BIND_PASSWORD);
        await client.unbind();
        validou = true; detalhe = `bind LDAP ok em ${hp.host}:${hp.port} — login por AD OK`;
      } catch (e) {
        const probe = await tlsProbe(hp.host, hp.port);
        if (probe.ok) { validou = true; detalhe = `TLS ok em ${hp.host}:${hp.port} (bind falhou: ${e.message} — caminho liberado, checar credencial)`; }
        else { detalhe = `${probe.msg} → liberar IP novo no FortiGate (${hp.port}/LDAPS)`; }
      }
      reg('Active Directory LDAPS', true, validou, detalhe, t0);
    }
  }

  console.log(`\n${C.bold}— Saída pra nuvem pública (não depende do FortiGate) —${C.reset}`);

  // 4) Pipefy GraphQL
  {
    const t0 = ms();
    try {
      const axios = require('axios');
      const resp = await axios.post('https://api.pipefy.com/graphql',
        { query: '{ me { name } }' },
        { headers: { Authorization: `Bearer ${process.env.PIPEFY_TOKEN}` }, timeout: 10000, validateStatus: () => true });
      const nome = resp.data?.data?.me?.name;
      reg('Pipefy API (webhooks/OP)', true, !!nome, nome ? `autenticado como "${nome}"` : `HTTP ${resp.status} — token inválido? ${JSON.stringify(resp.data?.errors || '').slice(0, 120)}`, t0);
    } catch (e) { reg('Pipefy API (webhooks/OP)', true, false, e.message, t0); }
  }

  // 5) Microsoft Graph (e-mail) — token client_credentials
  {
    const t0 = ms();
    const tenant = process.env.M365_TENANT_ID, cid = process.env.M365_CLIENT_ID, sec = process.env.M365_CLIENT_SECRET;
    if (!tenant || !cid || !sec) { reg('Microsoft Graph (e-mail)', true, false, 'M365_TENANT_ID/CLIENT_ID/CLIENT_SECRET ausentes', t0); }
    else {
      try {
        const axios = require('axios');
        const body = new URLSearchParams({ client_id: cid, client_secret: sec, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' });
        const resp = await axios.post(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, body.toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000, validateStatus: () => true });
        reg('Microsoft Graph (e-mail)', true, !!resp.data?.access_token, resp.data?.access_token ? 'token obtido — envio de e-mail (boletos/alertas) OK' : `HTTP ${resp.status}: ${resp.data?.error_description?.slice(0, 120) || resp.data?.error}`, t0);
      } catch (e) { reg('Microsoft Graph (e-mail)', true, false, e.message, t0); }
    }
  }

  // 6) Suri WhatsApp
  {
    const t0 = ms();
    const hp = parseHostPort(process.env.SURI_API_URL, 443);
    if (!hp) { reg('Suri WhatsApp', false, false, 'SURI_API_URL não configurado', t0); }
    else {
      const probe = await tlsProbe(hp.host, hp.port);
      reg('Suri WhatsApp', false, probe.ok, probe.ok ? `${hp.host} acessível — notificações/cobrança OK` : probe.msg, t0);
    }
  }

  console.log(`\n${C.bold}— Local (na própria VPS) —${C.reset}`);

  // 7) Postgres local
  {
    const t0 = ms();
    try {
      const { Client } = require('pg');
      const c = new Client({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT) || 5432, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD, connectionTimeoutMillis: 6000 });
      await c.connect(); await c.query('SELECT 1'); await c.end();
      reg('PostgreSQL local', true, true, 'banco da intranet respondendo', t0);
    } catch (e) { reg('PostgreSQL local', true, false, e.message, t0); }
  }

  // 8) API local (pm2) na 3000
  {
    const t0 = ms();
    const probe = await tcpProbe('127.0.0.1', Number(process.env.PORT) || 3000, 4000);
    reg('API local (pm2) :' + (process.env.PORT || 3000), true, probe.ok, probe.ok ? 'processo no ar' : `${probe.msg} — pm2 status?`, t0);
  }

  // ---- resumo ----
  const criticosFalhos = resultados.filter(r => r.critico && !r.passou);
  const okCount = resultados.filter(r => r.passou).length;
  console.log(`\n${C.bold}═══ Resumo: ${C.green}${okCount} OK${C.reset}${C.bold} · ${criticosFalhos.length ? C.red : C.green}${criticosFalhos.length} crítico(s) com falha${C.reset}${C.bold} de ${resultados.length} checagens ═══${C.reset}`);
  if (criticosFalhos.length) {
    console.log(`${C.red}${C.bold}\nAÇÃO NECESSÁRIA:${C.reset}`);
    criticosFalhos.forEach(r => console.log(`  ${C.red}• ${r.nome}: ${r.detalhe}${C.reset}`));
    console.log(`\n${C.dim}Dica: falhas de "porta não abre" nos itens Protheus/AD = a regra do FortiGate ainda aponta pro IP antigo.${C.reset}\n`);
    process.exit(1);
  }
  console.log(`${C.green}${C.bold}\nTudo verde — migração validada.${C.reset}\n`);
  process.exit(0);
})().catch(e => { console.error(`${C.red}Erro fatal no validador: ${e.stack || e.message}${C.reset}`); process.exit(2); });

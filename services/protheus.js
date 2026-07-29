// services/protheus.js — conexão SQL (mssql) com o Protheus. READ-ONLY (salvo as
// exceções documentadas: reserva de estoque e carteira simples do borderô).
//
// ⚠️ RESILIÊNCIA (29/07/2026): antes conectava UMA vez no boot e, se falhasse (ou a
// conexão caísse), o pool ficava MORTO pra sempre ("Connection is closed") até o
// pm2 reiniciar. Pior: o round-robin de `ddns.gnatus.com.br` inclui o IP
// 170.233.167.157 que NÃO publica 1433 → ~1/3 das conexões davam timeout.
// Agora:
//   1) FAILOVER multi-IP: tenta PROTHEUS_SERVER e depois cada um de
//      PROTHEUS_SERVERS (CSV), na ordem, até um conectar. Fixe IPs BONS (179 e 200
//      publicam 1433; 170 não) pra fugir do round-robin.
//   2) AUTO-RECONEXÃO: em erro transitório de conexão, zera o pool e refaz — a
//      próxima query reconecta sozinha (self-heal), com 1 retry imediato.

const sql = require('mssql');

// IPs/hosts candidatos, em ordem de preferência. 179.108.181.12 é o principal
// (publica 1433 e 8081); 200.15.18.119 é backup (publica 1433).
function candidatos() {
  const lista = [];
  const push = (v) => { v = String(v || '').trim(); if (v && !lista.includes(v)) lista.push(v); };
  push(process.env.PROTHEUS_SERVER);
  String(process.env.PROTHEUS_SERVERS || '').split(',').forEach(push);
  return lista.length ? lista : ['179.108.181.12'];
}

function baseConfig(server) {
  return {
    user: process.env.PROTHEUS_USER || '',
    password: process.env.PROTHEUS_PASSWORD || '',
    server,
    database: process.env.PROTHEUS_DATABASE || 'protheus',
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 15000,
    requestTimeout: 60000
  };
}

let pool = null;         // pool ativo (ou null = precisa reconectar)
let connecting = null;   // promise de conexão em andamento (dedup de concorrência)

// Tenta conectar em cada candidato, na ordem, até um funcionar.
async function conectar() {
  const ips = candidatos();
  let ultErro;
  for (const server of ips) {
    try {
      const p = new sql.ConnectionPool(baseConfig(server));
      p.on('error', (e) => { console.error('[protheus] pool erro:', e.message); if (pool === p) pool = null; });
      await p.connect();
      if (ips.length > 1) console.log('[protheus] conectado em', server);
      return p;
    } catch (e) {
      ultErro = e;
      console.error('[protheus] falha ao conectar em', server + ':', e.message);
    }
  }
  throw ultErro || new Error('Nenhum servidor Protheus disponível.');
}

function getPool() {
  if (pool) return Promise.resolve(pool);
  if (!connecting) {
    connecting = conectar()
      .then((p) => { pool = p; connecting = null; return p; })
      .catch((e) => { connecting = null; throw e; });
  }
  return connecting;
}

const TRANSITORIO = /Connection is closed|Connection not yet open|not connected|Connection lost|ECONNRESET|ETIMEDOUT|ESOCKET|socket hang up|EPIPE/i;

async function connectAndQuery(query, params = {}, _retry = 1) {
  try {
    const p = await getPool();
    const request = p.request();
    for (const key in params) request.input(key, params[key]);
    const result = await request.query(query);
    return result.recordset;
  } catch (error) {
    if (TRANSITORIO.test(error.message || '')) {
      const morto = pool; pool = null;                 // força reconexão na próxima
      try { if (morto) await morto.close(); } catch (e) { /* ignora */ }
      if (_retry > 0) return connectAndQuery(query, params, _retry - 1);
    }
    console.error('Erro em Protheus connectAndQuery:', error.message);
    throw error;
  }
}

// dispara a 1ª conexão no boot (sem derrubar o processo se falhar — self-heal cuida)
getPool().catch((err) => console.error('Conexão inicial com Protheus falhou:', err.message));

module.exports = {
  connectAndQuery,
  dbConfig: baseConfig(candidatos()[0])
};

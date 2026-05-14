// Cliente Microsoft Graph para upload/download/delete de arquivos num site
// SharePoint. Usado pelo modulo de Producao pra guardar anexos dos cards.
//
// IMPORTANTE: usa SharePoint SITE (Communication/Team site), nao OneDrive
// pessoal. Tentamos OneDrive pessoal da pipefy@gnatus.com.br inicialmente mas
// Application permissions nao acessam personal sites de forma confiavel.
// O destino agora eh um site dedicado: https://gnatus.sharepoint.com/sites/Pipefy
//
// Requer permission de APLICATIVO `Files.ReadWrite.All` (ou idealmente
// `Sites.Selected` + grant restrito ao site Pipefy) com admin consent no app
// "Intranet GNATUS - Reserva de Salas".
//
// .env:
//   M365_TENANT_ID / M365_CLIENT_ID / M365_CLIENT_SECRET (ja existem)
//   GRAPH_SP_HOSTNAME   (default: gnatus.sharepoint.com)
//   GRAPH_SP_SITE_PATH  (default: /sites/Pipefy)
//
// Limite: arquivo ate 4MB no PUT direto. Pra >4MB precisa upload session
// (nao implementado — F1 nao mira nisso).

const axios = require('axios');
const { ConfidentialClientApplication } = require('@azure/msal-node');

const TENANT_ID     = process.env.M365_TENANT_ID;
const CLIENT_ID     = process.env.M365_CLIENT_ID;
const CLIENT_SECRET = process.env.M365_CLIENT_SECRET;
const SP_HOSTNAME   = process.env.GRAPH_SP_HOSTNAME  || 'gnatus.sharepoint.com';
const SP_SITE_PATH  = process.env.GRAPH_SP_SITE_PATH || '/sites/Pipefy';

const MAX_SIMPLE_UPLOAD = 4 * 1024 * 1024;

let msal = null;
const getMsal = () => {
  if (msal) return msal;
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('M365_TENANT_ID / M365_CLIENT_ID / M365_CLIENT_SECRET nao configurados.');
  }
  msal = new ConfidentialClientApplication({
    auth: {
      clientId: CLIENT_ID,
      authority: `https://login.microsoftonline.com/${TENANT_ID}`,
      clientSecret: CLIENT_SECRET
    }
  });
  return msal;
};

// Cache de token. MSAL ja tem cache interno mas damos uma camada extra com
// margem de 60s pra renovar antes de expirar.
let cachedToken = null;
let cachedExpMs = 0;
async function getToken() {
  if (cachedToken && Date.now() < cachedExpMs - 60_000) return cachedToken;
  const r = await getMsal().acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default']
  });
  if (!r?.accessToken) throw new Error('Falha ao obter token Graph (sem accessToken).');
  cachedToken = r.accessToken;
  cachedExpMs = r.expiresOn?.getTime() || (Date.now() + 3500_000);
  return cachedToken;
}

const http = axios.create({
  baseURL: 'https://graph.microsoft.com/v1.0',
  timeout: 60_000,
  maxBodyLength: 5 * 1024 * 1024,
  maxContentLength: 5 * 1024 * 1024
});
http.interceptors.request.use(async (config) => {
  const token = await getToken();
  config.headers = config.headers || {};
  config.headers['Authorization'] = `Bearer ${token}`;
  return config;
});

// IDs do site + default drive, cacheados — nao mudam.
let cachedSiteId = null;
let cachedDriveId = null;

async function getSiteId() {
  if (cachedSiteId) return cachedSiteId;
  const cleanPath = SP_SITE_PATH.startsWith('/') ? SP_SITE_PATH : `/${SP_SITE_PATH}`;
  const { data } = await http.get(`/sites/${SP_HOSTNAME}:${cleanPath}`);
  cachedSiteId = data.id;
  return cachedSiteId;
}

// Default drive do site = biblioteca "Documentos" (Shared Documents)
async function getStorageDriveId() {
  if (cachedDriveId) return cachedDriveId;
  const siteId = await getSiteId();
  const { data } = await http.get(`/sites/${siteId}/drive`);
  cachedDriveId = data.id;
  return cachedDriveId;
}

// Codifica componentes do path mantendo a barra.
function encodePath(p) {
  return String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

// Upload de arquivo. `path` eh relativo ao root do drive, ex:
// "Producao Intranet/2026/00789801001_0000000001/etapa-03_rotulo.pdf"
// Pastas intermediarias sao criadas automaticamente pelo Graph.
async function uploadFile({ path, buffer, mime = 'application/octet-stream' }) {
  if (!path) throw new Error('path obrigatorio');
  if (!Buffer.isBuffer(buffer)) throw new Error('buffer precisa ser Buffer');
  if (buffer.length === 0) throw new Error('buffer vazio');
  if (buffer.length > MAX_SIMPLE_UPLOAD) {
    throw new Error(`Arquivo ${buffer.length} bytes > 4MB. Use upload session (nao implementado).`);
  }
  const driveId = await getStorageDriveId();
  const url = `/drives/${driveId}/root:/${encodePath(path)}:/content`;
  const { data } = await http.put(url, buffer, {
    headers: { 'Content-Type': mime }
  });
  return {
    drive_id: driveId,
    item_id: data.id,
    path,
    web_url: data.webUrl,
    size: data.size,
    name: data.name,
    mime: data.file?.mimeType || mime
  };
}

// Devolve URL de download direto (curta, valida ~1h, sem auth).
async function getDownloadUrl({ drive_id, item_id }) {
  const { data } = await http.get(
    `/drives/${drive_id}/items/${item_id}?select=@microsoft.graph.downloadUrl,name,size,file`
  );
  return {
    url: data['@microsoft.graph.downloadUrl'],
    name: data.name,
    size: data.size,
    mime: data.file?.mimeType || null
  };
}

async function deleteFile({ drive_id, item_id }) {
  await http.delete(`/drives/${drive_id}/items/${item_id}`);
  return { ok: true };
}

// Diagnostico — usado pelo script de teste.
async function testConnection() {
  try {
    const siteId = await getSiteId();
    const driveId = await getStorageDriveId();
    return {
      ok: true,
      hostname: SP_HOSTNAME,
      site_path: SP_SITE_PATH,
      site_id: siteId,
      drive_id: driveId
    };
  } catch (e) {
    return {
      ok: false,
      hostname: SP_HOSTNAME,
      site_path: SP_SITE_PATH,
      erro: e.response?.data?.error?.message || e.message
    };
  }
}

module.exports = {
  uploadFile,
  getDownloadUrl,
  deleteFile,
  getSiteId,
  getStorageDriveId,
  testConnection,
  SP_HOSTNAME,
  SP_SITE_PATH,
  MAX_SIMPLE_UPLOAD
};

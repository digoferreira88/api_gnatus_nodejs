// Cliente Microsoft Graph para upload/download/delete de arquivos no OneDrive
// (server-to-server, client credentials). Usado pelo modulo de Producao pra
// guardar anexos no mesmo destino que o Zapier hoje usa: OneDrive da conta
// pipefy@gnatus.com.br, pasta "Pipefy compartilhada".
//
// Mesma App Registration "Intranet GNATUS - Reserva de Salas" do m365.js,
// requer permission de APLICATIVO `Files.ReadWrite.All` com admin consent.
//
// .env:
//   M365_TENANT_ID / M365_CLIENT_ID / M365_CLIENT_SECRET (ja existem)
//   GRAPH_STORAGE_UPN  — UPN da conta cujo OneDrive armazena os anexos
//                        (default: pipefy@gnatus.com.br)
//
// Limite: arquivo ate 4MB no PUT direto. Pra >4MB precisa upload session
// (nao implementado — F1 nao mira nisso, fica pra quando aparecer caso real).

const axios = require('axios');
const { ConfidentialClientApplication } = require('@azure/msal-node');

const TENANT_ID     = process.env.M365_TENANT_ID;
const CLIENT_ID     = process.env.M365_CLIENT_ID;
const CLIENT_SECRET = process.env.M365_CLIENT_SECRET;
const STORAGE_UPN   = process.env.GRAPH_STORAGE_UPN || 'pipefy@gnatus.com.br';

const MAX_SIMPLE_UPLOAD = 4 * 1024 * 1024;  // 4MB — limite Graph PUT simples

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

// Drive da conta de armazenamento. Cacheado — drive id nao muda.
let cachedDriveId = null;
async function getStorageDriveId() {
  if (cachedDriveId) return cachedDriveId;
  const { data } = await http.get(`/users/${encodeURIComponent(STORAGE_UPN)}/drive`);
  cachedDriveId = data.id;
  return cachedDriveId;
}

// Codifica componentes do path mantendo a barra. "Pipefy compartilhada/teste a.txt"
// vira "Pipefy%20compartilhada/teste%20a.txt".
function encodePath(p) {
  return String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

// Upload de arquivo. `path` eh relativo ao root do drive, ex:
// "Pipefy compartilhada/Producao Intranet/2026/00789801001_0000000001/etapa-03_rotulo.pdf"
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
    const driveId = await getStorageDriveId();
    return { ok: true, drive_id: driveId, upn: STORAGE_UPN };
  } catch (e) {
    return {
      ok: false,
      erro: e.response?.data?.error?.message || e.message,
      upn: STORAGE_UPN
    };
  }
}

module.exports = {
  uploadFile,
  getDownloadUrl,
  deleteFile,
  getStorageDriveId,
  testConnection,
  STORAGE_UPN,
  MAX_SIMPLE_UPLOAD
};

// services/nfseBarretos.js — cliente REST do PADRÃO NACIONAL da NFS-e, no endpoint
// da RLZ/Barretos. Recebe o DPS ASSINADO (ver nfseAssinatura), comprime em gzip +
// base64 e faz POST JSON {dpsXmlGZipB64} via HTTPS com TLS mútuo (certificado A1).
// Retorna a NFS-e (chave + XML) ou as rejeições/alertas.
//
// Endpoints (RLZ/Barretos — Padrão Nacional):
//   Homologação (Produção Restrita): https://barretos.prefeitura.rlz.com.br/nota/nacional/nfse
//   Produção:                        https://cidadaoonline.barretos.sp.gov.br/nota/nacional/nfse
// Ambiente por .env: NFSE_AMBIENTE = homologacao (default) | producao.

const https = require('https');
const zlib = require('zlib');
const { carregarCertificado } = require('./nfseAssinatura');

const URLS = {
  homologacao: 'https://barretos.prefeitura.rlz.com.br/nota/nacional/nfse',
  producao: 'https://cidadaoonline.barretos.sp.gov.br/nota/nacional/nfse'
};
const ambiente = () => (String(process.env.NFSE_AMBIENTE || 'homologacao').toLowerCase() === 'producao' ? 'producao' : 'homologacao');
const urlWs = () => String(process.env.NFSE_WS_URL || URLS[ambiente()]);

const gzipB64 = (xml) => zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
const gunzipB64 = (b64) => { try { return zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'); } catch (e) { return ''; } };

function postJson(url, bodyObj) {
  return new Promise((resolve, reject) => {
    let cert;
    try { cert = carregarCertificado(); } catch (e) { return reject(new Error('Certificado indisponível: ' + e.message)); }
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = https.request({
      host: u.hostname, port: u.port || 443, path: u.pathname, method: 'POST',
      key: cert.privateKeyPem, cert: cert.chainPem || cert.certPem,   // cadeia completa p/ TLS mútuo ICP-Brasil
      rejectUnauthorized: false,                         // homolog pode ter cadeia incompleta
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'Content-Length': data.length
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    // Endpoint de PRODUÇÃO (cidadaoonline.barretos.sp.gov.br, .gov.br) às vezes trava —
    // um timeout curto gera "emitida na prefeitura mas ERRO do nosso lado" (ambiguidade
    // de timeout, ver incidente NF 001993 06/08/2026). Default 120s, ajustável por env.
    req.setTimeout(Number(process.env.NFSE_REST_TIMEOUT_MS) || 120000, () => req.destroy(new Error('timeout REST Barretos')));
    req.write(data);
    req.end();
  });
}

// Emite 1 DPS assinado. Retorna { ok, httpStatus, chaveAcesso, nfseXml, erros, alertas, raw }.
async function emitirDps(dpsAssinado) {
  const { status, body } = await postJson(urlWs(), { dpsXmlGZipB64: gzipB64(dpsAssinado) });
  let j = null; try { j = JSON.parse(body); } catch (e) {}
  const nfseXml = (j && j.nfseXmlGZipB64) ? gunzipB64(j.nfseXmlGZipB64) : '';
  return {
    ok: status === 200 || status === 201,
    httpStatus: status,
    chaveAcesso: (j && (j.chaveAcesso || j.ChaveAcesso)) || '',
    nfseXml,
    erros: (j && (j.erros || j.Erros)) || [],
    alertas: (j && (j.alertas || j.Alertas)) || [],
    raw: String(body || '').slice(0, 4000)
  };
}

module.exports = { emitirDps, urlWs, ambiente, gzipB64, gunzipB64 };

// services/nfseBarretos.js — cliente REST do PADRÃO NACIONAL da NFS-e. Recebe o DPS
// ASSINADO (ver nfseAssinatura), comprime em gzip + base64 e faz POST JSON
// {dpsXmlGZipB64} via HTTPS com TLS mútuo (certificado A1). Retorna a NFS-e (chave +
// XML) ou as rejeições/alertas.
//
// Destino: desde 01/11/2026 Barretos emite pelo EMISSOR NACIONAL (Sefin Nacional/RFB).
//   Produção:           https://sefin.nfse.gov.br/SefinNacional/nfse
//   Produção Restrita:  https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse
// Até 31/10/2026 o destino era o endpoint próprio da RLZ/Barretos (mesmo contrato):
//   https://cidadaoonline.barretos.sp.gov.br/nota/nacional/nfse (produção) e
//   https://barretos.prefeitura.rlz.com.br/nota/nacional/nfse (restrita).
// Ambiente por .env: NFSE_AMBIENTE = homologacao (default) | producao.
// NFSE_WS_URL sobrescreve o destino (rollback p/ o endpoint antigo, se preciso).
//
// ⚠️ A Produção Restrita nacional roda o leiaute da NT 009 desde 20/10/2026; a produção
// segue no 1.01 até a virada prevista para 01/12/2026. A restrita recusa (E1235) a DPS
// no leiaute de produção — não serve para validar o que vai para produção hoje.

const https = require('https');
const zlib = require('zlib');
const { carregarCertificado } = require('./nfseAssinatura');

const URLS = {
  homologacao: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse',
  producao: 'https://sefin.nfse.gov.br/SefinNacional/nfse'
};
const ambiente = () => (String(process.env.NFSE_AMBIENTE || 'homologacao').toLowerCase() === 'producao' ? 'producao' : 'homologacao');
const urlWs = () => String(process.env.NFSE_WS_URL || URLS[ambiente()]);
// Base da API nacional (sem o /nfse final), para as consultas. null = destino sem
// consultas (endpoint antigo da RLZ não expõe /dps nem /nfse/{chave}).
const baseNacional = () => {
  const u = urlWs().replace(/\/+$/, '');
  return /\/SefinNacional\/nfse$/i.test(u) ? u.replace(/\/nfse$/i, '') : null;
};

const gzipB64 = (xml) => zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
const gunzipB64 = (b64) => { try { return zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'); } catch (e) { return ''; } };

// A API nacional exige a declaração XML com UTF-8 (E1229 sem ela). Fica fora da
// assinatura (que é sobre infDPS), então pode ser acrescentada depois de assinar.
const DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const comDeclaracao = (xml) => (/^\s*<\?xml/i.test(xml) ? xml : DECL + xml);

// Erros vêm como {erros:[{Codigo,Descricao,Complemento}]} (às vezes minúsculo) ou, em
// alguns códigos HTTP, como {erro:{...}}. Normaliza para o formato com maiúscula.
function normalizarMsgs(lista) {
  return (Array.isArray(lista) ? lista : (lista ? [lista] : [])).map((e) => ({
    Codigo: (e && (e.Codigo || e.codigo)) || '',
    Descricao: (e && (e.Descricao || e.descricao)) || '',
    Complemento: (e && (e.Complemento || e.complemento)) || ''
  }));
}

function request(method, url, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    let cert;
    try { cert = carregarCertificado(); } catch (e) { return reject(new Error('Certificado indisponível: ' + e.message)); }
    const u = new URL(url);
    const data = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const headers = { 'Accept': 'application/json' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = https.request({
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method,
      key: cert.privateKeyPem, cert: cert.chainPem || cert.certPem,   // cadeia completa p/ TLS mútuo ICP-Brasil
      rejectUnauthorized: false,                         // homolog pode ter cadeia incompleta
      headers
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    // Timeout longo no envio: um timeout curto gera "emitida no fisco mas ERRO do nosso
    // lado" (incidente NF 001993, 06/08/2026). No emissor nacional a chave é recuperada
    // depois por GET /dps/{id} (consultarDps). Default 120s, ajustável por env.
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout REST NFS-e')));
    if (data) req.write(data);
    req.end();
  });
}

// Emite 1 DPS assinado. Retorna { ok, httpStatus, chaveAcesso, nfseXml, erros, alertas, raw }.
async function emitirDps(dpsAssinado) {
  const { status, body } = await request('POST', urlWs(), { dpsXmlGZipB64: gzipB64(comDeclaracao(dpsAssinado)) },
    Number(process.env.NFSE_REST_TIMEOUT_MS) || 120000);
  let j = null; try { j = JSON.parse(body); } catch (e) {}
  const nfseXml = (j && j.nfseXmlGZipB64) ? gunzipB64(j.nfseXmlGZipB64) : '';
  return {
    ok: status === 200 || status === 201,
    httpStatus: status,
    chaveAcesso: (j && (j.chaveAcesso || j.ChaveAcesso)) || '',
    nfseXml,
    erros: normalizarMsgs(j && (j.erros || j.Erros || j.erro || j.Erro)),
    alertas: normalizarMsgs(j && (j.alertas || j.Alertas)),
    raw: String(body || '').slice(0, 4000)
  };
}

// GET /dps/{id} — a NFS-e gerada a partir deste DPS. Usado para recuperar a chave quando
// o envio deu timeout ou voltou "já emitida". Retorna { encontrada, chaveAcesso,
// httpStatus } ou { encontrada:false, indisponivel:true } se o destino não tem consulta.
async function consultarDps(idDps) {
  const base = baseNacional();
  if (!base || !idDps) return { encontrada: false, indisponivel: true };
  const { status, body } = await request('GET', `${base}/dps/${encodeURIComponent(idDps)}`, null, 30000);
  let j = null; try { j = JSON.parse(body); } catch (e) {}
  const chave = (j && (j.chaveAcesso || j.ChaveAcesso)) || '';
  return { encontrada: status === 200 && !!chave, chaveAcesso: chave, httpStatus: status };
}

// GET /nfse/{chave} — o XML da NFS-e (para guardar e imprimir a via auxiliar).
async function consultarNfse(chave) {
  const base = baseNacional();
  if (!base || !chave) return { ok: false, indisponivel: true, nfseXml: '' };
  const { status, body } = await request('GET', `${base}/nfse/${encodeURIComponent(chave)}`, null, 30000);
  let j = null; try { j = JSON.parse(body); } catch (e) {}
  return { ok: status === 200, httpStatus: status, nfseXml: (j && j.nfseXmlGZipB64) ? gunzipB64(j.nfseXmlGZipB64) : '' };
}

module.exports = { emitirDps, consultarDps, consultarNfse, urlWs, baseNacional, ambiente, gzipB64, gunzipB64, comDeclaracao };

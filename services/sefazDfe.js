// services/sefazDfe.js — cliente do webservice SEFAZ NFeDistribuicaoDFe (Ambiente
// Nacional). Puxa os DOCUMENTOS FISCAIS RECEBIDOS (NF-e destinadas ao CNPJ) por
// NSU, direto na SEFAZ com o certificado A1 (mTLS) — SUBSTITUI o token frágil do
// TOTVS Transmite (ver memory integracao-transmite-fiscal). SOMENTE LEITURA.
//
// Auth: TLS mútuo com a cadeia do A1 (services/nfseAssinatura.carregarCertificado).
// SOAP 1.2. Método nfeDistDFeInteresse; payload distDFeInt (distNSU/ultNSU).
// Retorno: retDistDFeInt com loteDistDFeInt de <docZip> (base64+gzip: resNFe,
// procNFe, resEvento, procEventoNFe).
//
// Config (.env): DFE_TPAMB(1=prod) · DFE_CUF(35=SP) · DFE_CNPJ(matriz) · DFE_VERSAO · DFE_ENDPOINT.
// ⚠️ Limite de consumo da SEFAZ: ~1 consulta/hora quando NÃO há doc novo (cStat 656 se abusar).

const https = require('https');
const zlib = require('zlib');
const { carregarCertificado } = require('./nfseAssinatura');

const ENDPOINTS = {
  producao: 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
  homologacao: 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx'
};
const NS_WSDL = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe';
const NS_NFE = 'http://www.portalfiscal.inf.br/nfe';
const SOAP_ACTION = NS_WSDL + '/nfeDistDFeInteresse';

function cfg() {
  const tpAmb = Number(process.env.DFE_TPAMB || 1);
  return {
    tpAmb,
    cUF: String(process.env.DFE_CUF || '35'),
    cnpj: String(process.env.DFE_CNPJ || '09609356000100').replace(/\D/g, ''),
    versao: String(process.env.DFE_VERSAO || '1.35'),
    endpoint: process.env.DFE_ENDPOINT || ENDPOINTS[tpAmb === 2 ? 'homologacao' : 'producao']
  };
}

const pick = (xml, tag) => {
  const m = String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].trim() : '';
};

// distDFeInt por NSU (distNSU/ultNSU = último NSU já lido; SEFAZ devolve do próximo em diante).
function distDFeInt(ultNSU) {
  const c = cfg();
  const nsu = String(ultNSU || '0').replace(/\D/g, '').padStart(15, '0');
  return `<distDFeInt xmlns="${NS_NFE}" versao="${c.versao}">` +
    `<tpAmb>${c.tpAmb}</tpAmb>` +
    `<cUFAutor>${c.cUF}</cUFAutor>` +
    `<CNPJ>${c.cnpj}</CNPJ>` +
    `<distNSU><ultNSU>${nsu}</ultNSU></distNSU>` +
  `</distDFeInt>`;
}

function envelope(dist) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Body>` +
    `<nfeDistDFeInteresse xmlns="${NS_WSDL}"><nfeDadosMsg>${dist}</nfeDadosMsg></nfeDistDFeInteresse>` +
    `</soap12:Body></soap12:Envelope>`;
}

function post(xml) {
  return new Promise((resolve, reject) => {
    let cert; try { cert = carregarCertificado(); } catch (e) { return reject(new Error('Certificado indisponível: ' + e.message)); }
    const u = new URL(cfg().endpoint);
    const data = Buffer.from(xml, 'utf8');
    const req = https.request({
      host: u.hostname, port: 443, path: u.pathname, method: 'POST',
      key: cert.privateKeyPem, cert: cert.chainPem || cert.certPem,
      rejectUnauthorized: false, minVersion: 'TLSv1.2',
      headers: {
        'Content-Type': `application/soap+xml; charset=utf-8; action="${SOAP_ACTION}"`,
        'Content-Length': data.length
      }
    }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout SEFAZ DFe')));
    req.write(data); req.end();
  });
}

// Descompacta os <docZip> (base64+gzip) → [{ nsu, schema, xml }].
function extrairDocs(retXml) {
  const docs = [];
  const re = /<docZip\b([^>]*)>([\s\S]*?)<\/docZip>/gi;
  let m;
  while ((m = re.exec(retXml))) {
    const attrs = m[1];
    const nsu = (attrs.match(/NSU="(\d+)"/i) || [])[1] || '';
    const schema = (attrs.match(/schema="([^"]*)"/i) || [])[1] || '';
    let xml = '';
    try { xml = zlib.gunzipSync(Buffer.from(m[2].replace(/\s+/g, ''), 'base64')).toString('utf8'); } catch (e) {}
    docs.push({ nsu, schema, xml });
  }
  return docs;
}

// Resumo de 1 doc (chave/emitente/valor) p/ gravação — a partir do XML já descompactado.
function resumoDoc(d) {
  const x = d.xml || '';
  const chNFe = pick(x, 'chNFe') || (x.match(/Id="NFe(\d{44})"/) || [])[1] || '';
  return {
    nsu: d.nsu, schema: d.schema, chave: chNFe,
    cnpjEmit: pick(x, 'CNPJ') || pick(x, 'CPF'),
    nomeEmit: pick(x, 'xNome'),
    valor: pick(x, 'vNF'),
    dhEmi: pick(x, 'dhEmi'),
    cStat: pick(x, 'cSitNFe') || pick(x, 'cStat'),
    tpEvento: pick(x, 'tpEvento'),
    xml: x
  };
}

// Consulta 1 lote a partir de ultNSU. Retorna { httpStatus, cStat, xMotivo, ultNSU, maxNSU, docs[] }.
async function consultar(ultNSU) {
  const { status, body } = await post(envelope(distDFeInt(ultNSU)));
  const ret = (body.match(/<retDistDFeInt[\s\S]*?<\/retDistDFeInt>/i) || [body])[0];
  return {
    httpStatus: status,
    cStat: pick(ret, 'cStat'),
    xMotivo: pick(ret, 'xMotivo'),
    ultNSU: pick(ret, 'ultNSU'),
    maxNSU: pick(ret, 'maxNSU'),
    dhResp: pick(ret, 'dhResp'),
    docs: extrairDocs(ret).map(resumoDoc),
    raw: body.slice(0, 1500)
  };
}

// Ingestão (chamada pelo scheduler): lê o cursor de NSU, consulta lote(s), grava
// os novos docs e avança o cursor. Trata 656 (consumo indevido → para e tenta
// depois), 137 (nada novo) e 138 (documentos — segue até alcançar maxNSU).
// ⚠️ NUNCA reconsulta do 0 — parte sempre do ult_nsu guardado.
async function ingerir(app, { maxLotes = 8 } = {}) {
  const { Pg } = app.services;
  const cnpj = cfg().cnpj;
  const cur = await Pg.connectAndQuery(`SELECT ult_nsu FROM tab_dfe_nsu WHERE cnpj=@c`, { c: cnpj });
  let ultNSU = cur.length ? String(cur[0].ult_nsu) : '0';
  let novos = 0, lotes = 0, cStat = '';
  for (let i = 0; i < maxLotes; i++) {
    const r = await consultar(ultNSU);
    lotes++; cStat = r.cStat;
    if (r.cStat === '656') break;                    // consumo indevido → para (tenta na próxima rodada)
    for (const d of r.docs) {
      const ins = await Pg.connectAndQuery(
        `INSERT INTO tab_dfe_recebida (nsu, chave, schema_dfe, cnpj_emit, nome_emit, valor, dh_emi, cstat, tp_evento, xml)
         VALUES (@nsu,@ch,@sc,@ce,@ne,@v,@dh,@cst,@te,@xml) ON CONFLICT (nsu) DO NOTHING RETURNING nsu`,
        { nsu: d.nsu, ch: d.chave || null, sc: d.schema, ce: d.cnpjEmit || null, ne: d.nomeEmit || null,
          v: d.valor ? Number(d.valor) : null, dh: d.dhEmi || null, cst: d.cStat || null,
          te: d.tpEvento || null, xml: d.xml });
      if (ins.length) novos++;
    }
    if (r.ultNSU && r.ultNSU !== ultNSU) {
      ultNSU = r.ultNSU;
      await Pg.connectAndQuery(
        `INSERT INTO tab_dfe_nsu (cnpj, ult_nsu, max_nsu, atualizado_em) VALUES (@c,@u,@m,NOW())
         ON CONFLICT (cnpj) DO UPDATE SET ult_nsu=@u, max_nsu=COALESCE(@m,tab_dfe_nsu.max_nsu), atualizado_em=NOW()`,
        { c: cnpj, u: ultNSU, m: r.maxNSU || null });
    }
    if (r.cStat === '137') break;                    // nada novo
    if (r.maxNSU && ultNSU >= r.maxNSU) break;       // alcançou o fim da fila
  }
  return { novos, lotes, ultNSU, cStat };
}

module.exports = { consultar, ingerir, distDFeInt, resumoDoc, cfg, ENDPOINTS };

// services/nfseAssinatura.js — assinatura XMLDSig do DPS (Padrão Nacional NFS-e)
// com o certificado A1 (e-CNPJ da Gnatus). Também expõe a cadeia PEM p/ o TLS mútuo.
//
// Lê o .pfx (PKCS#12) com **node-forge** (JS puro) — de propósito, porque o
// OpenSSL 3 do Node 22 costuma REJEITAR os A1 ICP-Brasil (criptografia legada
// RC2/3DES) com "unsupported"; o forge não depende do provider do OpenSSL.
// Assina com **xml-crypto**.
//
// Padrão ABRASF 2.03: RSA-SHA1 + DigestSHA1 + C14N, assinatura ENVELOPED sobre o
// elemento <InfDeclaracaoPrestacaoServico Id="..."> (ver services/nfseXml.js),
// com <KeyInfo><X509Data><X509Certificate> do titular. O <Signature> entra DENTRO
// do <Rps>, logo após o InfDeclaracao.
//
// Config (.env, na VPS):
//   NFSE_CERT_PATH = /home/intranet/certs/gnatus.pfx   (arquivo FORA do git, perm 600)
//   NFSE_CERT_PASS = <senha do .pfx>                    (NUNCA no chat/git)

const fs = require('fs');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');

const CERT_PATH = () => String(process.env.NFSE_CERT_PATH || '').trim();
const CERT_PASS = () => String(process.env.NFSE_CERT_PASS || '');

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
// ⚠️ Barretos / Padrão Nacional v1.00 exige RSA-SHA1 + SHA-1 (confirmado pela RLZ
// em 29/07/2026 — a 1ª NFS-e ACEITA usou SHA-1; SHA-256 não bate com o XSD v1.00).
// SHA-256 fica no mapa caso uma versão futura do leiaute volte a exigir.
const ALG = {
  1:   { sig: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',        dig: 'http://www.w3.org/2000/09/xmldsig#sha1' },
  256: { sig: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', dig: 'http://www.w3.org/2001/04/xmlenc#sha256' }
};

let _cache = null;   // { privateKeyPem, certPem, certDer64, notAfter, subject }

// Escolhe o certificado do TITULAR entre os bags (o .pfx ICP-Brasil traz a cadeia:
// AC raiz + intermediária + folha). A folha é a que casa com a chave privada.
function escolherCertTitular(certBags, privateKey) {
  const nPriv = privateKey.n.toString(16);
  for (const b of certBags) {
    try { if (b.cert.publicKey && b.cert.publicKey.n && b.cert.publicKey.n.toString(16) === nPriv) return b.cert; } catch (e) {}
  }
  // fallback: a que NÃO é auto-assinada (issuer != subject) — folha, não a AC raiz
  const folha = certBags.find(b => forge.pki.getPublicKeyFingerprint && b.cert.issuer.hash !== b.cert.subject.hash);
  return (folha && folha.cert) || certBags[0].cert;
}

// Carrega o .pfx uma vez (cacheia). Lança erro claro se path/senha errados.
function carregarCertificado() {
  if (_cache) return _cache;
  const path = CERT_PATH();
  if (!path) throw new Error('NFSE_CERT_PATH não configurado no .env.');
  if (!fs.existsSync(path)) throw new Error('Certificado não encontrado em ' + path);

  let p12;
  try {
    const p12Der = fs.readFileSync(path, 'binary');
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, CERT_PASS());   // false = lenient (A1 legado)
  } catch (e) {
    throw new Error('Falha ao abrir o .pfx (senha incorreta ou arquivo inválido): ' + e.message);
  }

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]
    || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag];
  if (!keyBags || !keyBags[0]) throw new Error('Chave privada não encontrada no .pfx.');
  const privateKey = keyBags[0].key;

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!certBags.length) throw new Error('Certificado não encontrado no .pfx.');
  const cert = escolherCertTitular(certBags, privateKey);

  // Cadeia completa p/ o TLS mútuo (leaf + ACs intermediárias + raiz). Sem ela o
  // servidor ICP-Brasil responde "tlsv1 alert unknown ca" no handshake.
  const chainPem = [cert, ...certBags.map(b => b.cert).filter(c => c !== cert)]
    .map(c => forge.pki.certificateToPem(c)).join('\n');

  _cache = {
    privateKeyPem: forge.pki.privateKeyToPem(privateKey),
    certPem: forge.pki.certificateToPem(cert),
    chainPem,
    certDer64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()),
    notAfter: cert.validity.notAfter,
    subject: (cert.subject.getField('CN') || {}).value || ''
  };
  return _cache;
}

// Assina um XML no padrão XMLDSig, ENVELOPED sobre o elemento `referencia`
// (padrão = <infDPS> do DPS Padrão Nacional). RSA-SHA{sha}: Barretos v1.00 = 1
// (SHA-1) — é o DEFAULT (foi o que a prefeitura aceitou). Retorna o XML assinado.
function assinarXml(xml, { referencia = "//*[local-name(.)='infDPS']", sha = 1, posicao = 'after' } = {}) {
  const { privateKeyPem, certDer64 } = carregarCertificado();
  const alg = ALG[sha] || ALG[256];
  const sig = new SignedXml({
    privateKey: privateKeyPem,
    signatureAlgorithm: alg.sig,
    canonicalizationAlgorithm: C14N
  });
  sig.addReference({ xpath: referencia, digestAlgorithm: alg.dig, transforms: [ENVELOPED, C14N] });
  sig.getKeyInfoContent = () => `<X509Data><X509Certificate>${certDer64}</X509Certificate></X509Data>`;
  sig.computeSignature(xml, { location: { reference: referencia, action: posicao } });
  return sig.getSignedXml();
}

// Diagnóstico (sem assinar): confirma que o .pfx abre e mostra titular/validade.
function infoCertificado() {
  const c = carregarCertificado();
  return { subject: c.subject, notAfter: c.notAfter, ok: true };
}

module.exports = { carregarCertificado, assinarXml, infoCertificado };

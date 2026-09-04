// services/nfseDistribuicaoAdn.js — cliente da DISTRIBUIÇÃO de DF-e da NFS-e
// Padrão Nacional (Ambiente de Dados Nacional / ADN). Puxa as NOTAS DE SERVIÇO
// do contribuinte (a Gnatus como TOMADORA — e também as emitidas) por NSU
// incremental, direto no ADN com o A1 (mTLS). É o análogo do services/sefazDfe.js,
// só que REST/JSON (não SOAP) e para NFS-e. SOMENTE LEITURA.
//
// Auth: TLS mútuo com a cadeia do A1 (services/nfseAssinatura.carregarCertificado).
// O certificado identifica o CNPJ, então o ADN já devolve só os documentos da
// Gnatus — não há parâmetro de CNPJ.
//
// Contrato (validado 04/09/2026 com o nosso A1):
//   GET {BASE}/dfe/{NSU}?tipoNSU=DISTRIBUICAO   (BASE=https://adn.nfse.gov.br/contribuintes)
//   -> { StatusProcessamento, LoteDFe:[{ NSU, ChaveAcesso, TipoDocumento, ArquivoXml }],
//        Alertas, Erros, TipoAmbiente, VersaoAplicativo, DataHoraProcessamento }
//   ArquivoXml = gzip+base64 do XML da NFS-e. NSU incremental (devolve do NSU
//   seguinte em diante), lote de até 50. Sem maxNSU no envelope — a última página
//   é a que vem com < 50 docs (ou StatusProcessamento sem documentos).
//
// Config (.env): NFSE_ADN_BASE (default abaixo) · NFSE_CERT_PATH/NFSE_CERT_PASS (o A1).

const https = require('https');
const zlib = require('zlib');
const { carregarCertificado } = require('./nfseAssinatura');

const BASE = () => String(process.env.NFSE_ADN_BASE || 'https://adn.nfse.gov.br/contribuintes').replace(/\/$/, '');
const GNATUS_RAIZ = '09609356';                 // raiz do CNPJ (todas as filiais Gnatus)
const LOTE_MAX = 50;

// ---- helpers de parsing do XML da NFS-e (namespace default, tags sem prefixo) ----
const between = (xml, tag) => {
  const m = String(xml).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
};
const pick = (xml, tag) => between(xml, tag).trim();
const soDig = (v) => String(v || '').replace(/\D/g, '');

function cfg() {
  return { base: BASE(), cnpj: soDig(process.env.DFE_CNPJ || '09609356000100') };
}

function get(nsu) {
  return new Promise((resolve, reject) => {
    let cert; try { cert = carregarCertificado(); } catch (e) { return reject(new Error('Certificado indisponível: ' + e.message)); }
    const u = new URL(`${BASE()}/dfe/${Number(nsu) || 0}?tipoNSU=DISTRIBUICAO`);
    const req = https.request({
      host: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      key: cert.privateKeyPem, cert: cert.chainPem || cert.certPem,
      rejectUnauthorized: false, minVersion: 'TLSv1.2',
      headers: { Accept: 'application/json' }
    }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout ADN NFS-e')));
    req.end();
  });
}

// gzip+base64 -> XML (com fallback pra base64 puro, caso não venha comprimido)
function descompactar(b64) {
  const raw = Buffer.from(String(b64 || '').replace(/\s+/g, ''), 'base64');
  try { return zlib.gunzipSync(raw).toString('utf8'); } catch (e) { return raw.toString('utf8'); }
}

// Extrai os campos de negócio de 1 XML de NFS-e já descompactado.
function parseNfse(xml, chaveLote, tipoDoc) {
  const x = xml || '';
  const emit = between(x, 'emit');
  const toma = between(x, 'toma');
  const val = between(x, 'valores');
  const emitCnpj = soDig(pick(emit, 'CNPJ') || pick(emit, 'CPF'));
  const tomaCnpj = soDig(pick(toma, 'CNPJ') || pick(toma, 'CPF'));

  // direção: se a Gnatus é o tomador -> recebida; se é o prestador -> emitida.
  let direcao = 'recebida';
  if (tomaCnpj.startsWith(GNATUS_RAIZ)) direcao = 'recebida';
  else if (emitCnpj.startsWith(GNATUS_RAIZ)) direcao = 'emitida';

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const chave = soDig(chaveLote) || soDig((x.match(/Id="NFS(\d{50})"/) || [])[1]);

  return {
    chave,
    tipoDoc: tipoDoc || 'NFSE',
    numero: pick(x, 'nNFSe') || null,
    serie: pick(x, 'serie') || null,
    emitCnpj: emitCnpj || null,
    emitNome: pick(emit, 'xNome') || pick(emit, 'xFant') || null,
    emitMun: pick(emit, 'cMun') || null,
    emitUf: pick(emit, 'UF') || null,
    emitMunNome: pick(x, 'xLocEmi') || null,
    tomaCnpj: tomaCnpj || null,
    tomaNome: pick(toma, 'xNome') || null,
    direcao,
    valor: num(pick(val, 'vLiq')),
    valorIss: num(pick(val, 'vISSQN')),
    aliq: num(pick(val, 'pAliqAplic')),
    descServico: (pick(x, 'xDescServ') || '').slice(0, 500) || null,
    ctribNac: pick(x, 'cTribNac') || null,
    dhEmi: pick(x, 'dhEmi') || null,
    dhProc: pick(x, 'dhProc') || null,
    competencia: (pick(x, 'dCompet') || '').slice(0, 10) || null,
    cstat: pick(x, 'cStat') || null,
    xml: x
  };
}

// Consulta 1 lote a partir de ultNSU. Retorna { httpStatus, status, docs[], ultNSUlote, cheio }.
async function consultar(ultNSU) {
  const { status, body } = await get(ultNSU);
  let j; try { j = JSON.parse(body); } catch (e) { j = null; }
  if (!j) return { httpStatus: status, status: 'ERRO_PARSE', docs: [], ultNSUlote: Number(ultNSU) || 0, cheio: false, raw: String(body).slice(0, 800) };

  const lote = Array.isArray(j.LoteDFe) ? j.LoteDFe : [];
  const docs = lote.map((d) => {
    const tipo = String(d.TipoDocumento || '').toUpperCase();
    const xml = d.ArquivoXml ? descompactar(d.ArquivoXml) : '';
    const parsed = (tipo === 'NFSE' || tipo === '') ? parseNfse(xml, d.ChaveAcesso, tipo) : {
      chave: soDig(d.ChaveAcesso), tipoDoc: tipo || 'EVENTO', xml, direcao: 'recebida'
    };
    return { nsu: Number(d.NSU) || 0, chaveAcesso: soDig(d.ChaveAcesso), tipoDocumento: tipo, ...parsed };
  });
  const ultNSUlote = docs.reduce((mx, d) => Math.max(mx, d.nsu), Number(ultNSU) || 0);

  return {
    httpStatus: status,
    status: j.StatusProcessamento || '',
    tipoAmbiente: j.TipoAmbiente,
    versao: j.VersaoAplicativo,
    alertas: j.Alertas || [],
    erros: j.Erros || [],
    docs,
    ultNSUlote,
    cheio: lote.length >= LOTE_MAX          // lote cheio => provavelmente há mais páginas
  };
}

// Ingestão (scheduler/manual): lê o cursor de NSU, consulta lote(s), grava os novos
// docs e avança o cursor. Para quando StatusProcessamento não tem documentos, o
// lote vem incompleto (< 50) ou atinge maxLotes. ⚠️ NUNCA reconsulta do 0.
async function ingerir(app, { maxLotes = 6 } = {}) {
  const { Pg } = app.services;
  const cnpj = cfg().cnpj;
  const cur = await Pg.connectAndQuery(`SELECT ult_nsu FROM tab_nfse_adn_nsu WHERE cnpj=@c`, { c: cnpj });
  let ultNSU = cur.length ? Number(cur[0].ult_nsu) : 0;

  let novos = 0, lotes = 0, ultStatus = '', ambiente = null;
  for (let i = 0; i < maxLotes; i++) {
    const r = await consultar(ultNSU);
    lotes++; ultStatus = r.status; ambiente = r.tipoAmbiente;

    if (r.httpStatus !== 200) { ultStatus = `HTTP_${r.httpStatus}`; break; }

    for (const d of r.docs) {
      if (!d.chave) continue;
      const ins = await Pg.connectAndQuery(
        `INSERT INTO tab_nfse_recebida
           (chave, nsu, tipo_doc, numero, serie, emit_cnpj, emit_nome, emit_mun, emit_uf, emit_mun_nome,
            toma_cnpj, toma_nome, direcao, valor, valor_iss, aliq, desc_servico, ctrib_nac,
            dh_emi, dh_proc, competencia, cstat, xml)
         VALUES (@chave,@nsu,@tipo,@num,@serie,@ecnpj,@enome,@emun,@euf,@emunnome,
                 @tcnpj,@tnome,@dir,@val,@iss,@aliq,@desc,@ctrib,
                 @dhemi,@dhproc,@compet,@cstat,@xml)
         ON CONFLICT (chave) DO NOTHING RETURNING chave`,
        {
          chave: d.chave, nsu: d.nsu, tipo: d.tipoDoc || null, num: d.numero || null, serie: d.serie || null,
          ecnpj: d.emitCnpj || null, enome: d.emitNome || null, emun: d.emitMun || null, euf: d.emitUf || null,
          emunnome: d.emitMunNome || null, tcnpj: d.tomaCnpj || null, tnome: d.tomaNome || null,
          dir: d.direcao || 'recebida', val: d.valor, iss: d.valorIss, aliq: d.aliq,
          desc: d.descServico || null, ctrib: d.ctribNac || null,
          dhemi: d.dhEmi || null, dhproc: d.dhProc || null, compet: d.competencia || null,
          cstat: d.cstat || null, xml: d.xml || null
        });
      if (ins.length) novos++;
    }

    if (r.ultNSUlote > ultNSU) {
      ultNSU = r.ultNSUlote;
      await Pg.connectAndQuery(
        `INSERT INTO tab_nfse_adn_nsu (cnpj, ult_nsu, max_nsu, atualizado_em) VALUES (@c,@u,@u,NOW())
         ON CONFLICT (cnpj) DO UPDATE SET ult_nsu=@u,
           max_nsu=GREATEST(COALESCE(tab_nfse_adn_nsu.max_nsu,0), @u), atualizado_em=NOW()`,
        { c: cnpj, u: ultNSU });
    }

    if (!r.docs.length || !r.cheio) break;   // acabou a fila (lote incompleto ou vazio)
  }
  return { novos, lotes, ultNSU, status: ultStatus, ambiente };
}

module.exports = { consultar, ingerir, parseNfse, cfg, GNATUS_RAIZ };

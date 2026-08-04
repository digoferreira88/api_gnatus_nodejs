// services/nfseXml.js — Gerador do DPS (Declaração de Prestação de Serviço) no
// PADRÃO NACIONAL da NFS-e (nfse.gov.br), usado por Barretos desde 2025.
// (O ABRASF 2.03 foi descontinuado — ver docs/proposta-nfse-barretos-hub-intranet.md §9.)
//
// PURO: não assina, não faz rede — monta o XML <DPS> a partir de uma "nota"
// normalizada (services/nfseProtheus.js) + a config fiscal do prestador. A
// assinatura (XMLDSig RSA-SHA1 sobre <infDPS Id=...>) é aplicada depois em
// services/nfseAssinatura.js; o envio (gzip+base64+REST) em services/nfseBarretos.js.
//
// Namespace: http://www.sped.fazenda.gov.br/nfse · versao 1.00.
// ⚠️ Layout construído a partir do MOC do Padrão Nacional; ajustar fino pelas
// rejeições da Produção Restrita (fluxo recomendado pela RLZ).

const IBGE_UF = {
  AC: '12', AL: '27', AP: '16', AM: '13', BA: '29', CE: '23', DF: '53', ES: '32',
  GO: '52', MA: '21', MT: '51', MS: '50', MG: '31', PA: '15', PB: '25', PR: '41',
  PE: '26', PI: '22', RJ: '33', RN: '24', RS: '43', RO: '11', RR: '14', SC: '42',
  SP: '35', SE: '28', TO: '17'
};

const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const money = (v) => Number(v || 0).toFixed(2);
const trim = (v) => String(v == null ? '' : v).trim();
const esc = (v) => trim(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// IBGE (7 díg) do município a partir de UF + A1_COD_MUN (Protheus guarda 5 díg).
function ibgeMunicipio(uf, codMun) {
  const pref = IBGE_UF[trim(uf).toUpperCase()];
  const c = soDig(codMun);
  if (!pref || c.length < 4) return '';
  return pref + c.padStart(5, '0').slice(-5);
}

// dhEmi no formato ISO com offset -03:00 (horário de Brasília, sem horário de verão).
function dhEmiAgora() {
  const d = new Date(Date.now() - 3 * 3600 * 1000);   // desloca p/ -03:00 e formata como UTC
  return d.toISOString().replace(/\.\d{3}Z$/, '-03:00');
}

// dCompet precisa ser DATA COMPLETA (YYYY-MM-DD) — a RLZ rejeita YYYY-MM (29/07/2026).
// Aceita já-completa; YYYY-MM vira dia 01; vazio → hoje.
function dataCompet(v) {
  const s = trim(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return s + '-01';
  return dhEmiAgora().slice(0, 10);
}

// Id do infDPS (padrão nacional, 45 chars após "DPS"):
//   "DPS" + cMunEmi(7) + tpInsc(1) + inscrFederal(14) + serie(5) + nDPS(15)
function idInfDps(cMunEmi, cnpjPrest, serie, nDps) {
  const insc = soDig(cnpjPrest);
  const tpInsc = insc.length === 11 ? '1' : '2';          // 1=CPF, 2=CNPJ
  return 'DPS' + soDig(cMunEmi).padStart(7, '0')
    + tpInsc + insc.padStart(14, '0')
    + soDig(serie).padStart(5, '0')
    + soDig(nDps).padStart(15, '0');
}

function blocoPrest(cfg) {
  return `<prest>` +
    `<CNPJ>${soDig(cfg.cnpjPrestador)}</CNPJ>` +
    `<IM>${esc(cfg.inscricaoMunicipalPrestador)}</IM>` +
    `<regTrib>` +
      `<opSimpNac>${cfg.opSimpNac || 1}</opSimpNac>` +        // 1=Não optante (Lucro Real), 2=MEI, 3=ME/EPP
      `<regEspTrib>${cfg.regEspTrib || 0}</regEspTrib>` +     // 0=Nenhum
    `</regTrib>` +
  `</prest>`;
}

function blocoToma(t) {
  const doc = soDig(t.cpfCnpj);
  const tagDoc = doc.length === 11 ? `<CPF>${doc}</CPF>` : `<CNPJ>${doc}</CNPJ>`;
  const ibge = t.codMunicipioIbge || ibgeMunicipio(t.uf, t.codMunicipio);
  return `<toma>` +
    tagDoc +
    (trim(t.inscricaoMunicipal) ? `<IM>${esc(t.inscricaoMunicipal)}</IM>` : '') +
    `<xNome>${esc(t.razaoSocial)}</xNome>` +
    `<end>` +
      `<endNac>` +
        `<cMun>${esc(ibge)}</cMun>` +
        `<CEP>${soDig(t.cep)}</CEP>` +
      `</endNac>` +
      `<xLgr>${esc(t.endereco) || 'NAO INFORMADO'}</xLgr>` +
      `<nro>${esc(t.numero) || 'S/N'}</nro>` +
      `<xBairro>${esc(t.bairro) || 'NAO INFORMADO'}</xBairro>` +
    `</end>` +
    (trim(t.email) ? `<email>${esc(t.email)}</email>` : '') +
  `</toma>`;
}

// 🔶 IBS/CBS (Reforma Tributária, LC 214/2025) — grupos exigidos por Barretos desde
// 03/08/2026 (NT SE/CGNFS-e nº 004, leiaute AnexoVI-RTC_IBSCBS V1.01.x).
// Nomes de campos e valores confirmados na NT004 + orientação do fiscal (04/08):
//   CST=000 (tributação integral), cClassTrib=000001, cIndOp por serviço (de-para),
//   finNFSe=0 (regular), indFinal=0, indDest=0 (tomador=adquirente=destinatário),
//   "compra governamental? Não" → grupo tpEnteGov omitido.
// ⚠️ PROVISÓRIO — a ORDEM exata dos elementos e o bump de versão (1.00→1.01) ainda
// precisam ser batidos contra o XSD oficial / iterando na Produção Restrita (fluxo
// recomendado pela RLZ). Tudo aqui só sai quando cfg.ibsCbs=true (env NFSE_IBSCBS).
const IBSCBS_CST = '000';
const IBSCBS_CCLASSTRIB = '000001';

// valores/trib/gIBSCBS — destaque tributário do item (CST + cClassTrib, ambos 1-1).
function grupoGIbsCbs(cfg) {
  return `<gIBSCBS>` +
    `<CST>${esc(cfg.cstIbsCbs || IBSCBS_CST)}</CST>` +
    `<cClassTrib>${esc(cfg.cClassTrib || IBSCBS_CCLASSTRIB)}</cClassTrib>` +
  `</gIBSCBS>`;
}

// infDPS/IBSCBS — grupo de operação (finNFSe/indFinal/cIndOp/indDest).
function blocoIbsCbsOper(cfg) {
  const cIndOp = soDig(cfg.cIndOp);
  return `<IBSCBS>` +
    `<finNFSe>0</finNFSe>` +
    `<indFinal>0</indFinal>` +
    (cIndOp ? `<cIndOp>${esc(cIndOp)}</cIndOp>` : '') +
    `<indDest>0</indDest>` +
  `</IBSCBS>`;
}

function blocoServValores(nota, cfg) {
  const cLoc = soDig(cfg.codigoMunicipioPrestador);          // Barretos 3505500 (prestação)
  // cTribNac = código nacional SEM pontos (ex.: "080201"). Barretos localiza o
  // serviço por cTribNac + CNPJ + IM do prestador. ⚠️ cTribMun NÃO deve ser
  // informado nesse cenário (orientação RLZ 29/07/2026 — a 1ª nota aceita foi sem).
  const cTribNac = soDig(nota.itemListaServico || cfg.cTribNacPadrao);
  const cNBS = soDig(cfg.cNBS);                               // NBS sem pontos (IBS/CBS)
  const serv = `<serv>` +
    `<locPrest><cLocPrestacao>${cLoc}</cLocPrestacao></locPrest>` +
    `<cServ>` +
      `<cTribNac>${esc(cTribNac)}</cTribNac>` +
      `<xDescServ>${esc(nota.discriminacao)}</xDescServ>` +
      ((cfg.ibsCbs && cNBS) ? `<cNBS>${esc(cNBS)}</cNBS>` : '') +
    `</cServ>` +
  `</serv>`;
  const valores = `<valores>` +
    `<vServPrest><vServ>${money(nota.valorServicos)}</vServ></vServPrest>` +
    `<trib>` +
      `<tribMun>` +
        `<tribISSQN>1</tribISSQN>` +                          // 1=Operação tributável
        `<tpRetISSQN>${nota.issRetido ? 2 : 1}</tpRetISSQN>` + // 1=Não retido, 2=Retido tomador
      `</tribMun>` +                                           // alíquota NÃO vai no DPS — a prefeitura calcula
      (cfg.ibsCbs ? grupoGIbsCbs(cfg) : '') +
      `<totTrib><indTotTrib>0</indTotTrib></totTrib>` +        // 0=Não informa (aprox. Lei 12.741)
    `</trib>` +
  `</valores>`;
  return serv + valores;
}

// Monta o <DPS> (sem assinatura). Retorna { xml, id }.
// ⚠️ A série do DPS é NUMÉRICA (datatype TSSerieDPS) — independente da série do
// Protheus ("C", letra). Usa cfg.serieDps (default "1").
function montarDps(nota, cfg) {
  const cMunEmi = soDig(cfg.codigoMunicipioPrestador);
  const serie = soDig(cfg.serieDps) || '1';                    // série do DPS = numérica
  const id = idInfDps(cMunEmi, cfg.cnpjPrestador, serie, nota.rps.numero);
  const tpAmb = cfg.tpAmb || 2;                                // 2=Produção Restrita (homologação)
  // Versão do LEIAUTE (atributo do <DPS>). Com IBS/CBS bate no leiaute RTC (1.01).
  // ⚠️ confirmar a string exata no XSD (pode ser "1.01"); override via cfg.versaoLeiaute.
  const versao = trim(cfg.versaoLeiaute) || (cfg.ibsCbs ? '1.01' : '1.00');

  const inf =
    `<infDPS Id="${id}">` +
      `<tpAmb>${tpAmb}</tpAmb>` +
      `<dhEmi>${dhEmiAgora()}</dhEmi>` +
      `<verAplic>${esc(cfg.verAplic || '1.00')}</verAplic>` +  // versão do APLICATIVO emissor (não do leiaute)
      `<serie>${esc(serie)}</serie>` +
      `<nDPS>${soDig(nota.rps.numero).replace(/^0+/, '') || '0'}</nDPS>` +   // sem zeros à esquerda (TSNumDPS)
      `<dCompet>${dataCompet(nota.competencia || nota.dataEmissao)}</dCompet>` +
      `<tpEmit>1</tpEmit>` +                                   // 1=Prestador
      `<cLocEmi>${cMunEmi}</cLocEmi>` +
      blocoPrest(cfg) +
      blocoToma(nota.tomador) +
      blocoServValores(nota, cfg) +
      (cfg.ibsCbs ? blocoIbsCbsOper(cfg) : '') +               // infDPS/IBSCBS (⚠️ posição a confirmar no XSD)
    `</infDPS>`;

  const xml = `<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="${esc(versao)}">${inf}</DPS>`;
  return { xml, id };
}

module.exports = { montarDps, ibgeMunicipio, idInfDps, IBGE_UF };

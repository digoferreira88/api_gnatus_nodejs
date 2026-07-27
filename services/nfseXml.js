// services/nfseXml.js — Gerador do RPS no padrão ABRASF 2.03 (NFS-e Barretos/RLZ).
//
// PURO: não assina, não faz rede — só monta o XML <GerarNfseEnvio> a partir de uma
// "nota" normalizada (ver services/nfseProtheus.js) + a config fiscal do prestador.
// A assinatura XMLDSig (com o certificado A1) é aplicada depois, em
// services/nfseAssinatura.js, sobre o elemento InfDeclaracaoPrestacaoServico (Id).
//
// Namespace do conteúdo ABRASF 2.03: http://www.abrasf.org.br/nfse.xsd
// Envelope SOAP do webservice: nfseCabecMsg + nfseDadosMsg (ver nfseBarretos.js).
//
// ⚠️ Campos fiscais (inscrição municipal do prestador, item LC116, alíquota ISS)
// vêm da CONFIG — hoje são placeholders/env até o fiscal fechar o de-para.

const IBGE_UF = {  // prefixo IBGE (2 díg) por UF — IBGE completo = prefixo + A1_COD_MUN(5)
  AC: '12', AL: '27', AP: '16', AM: '13', BA: '29', CE: '23', DF: '53', ES: '32',
  GO: '52', MA: '21', MT: '51', MS: '50', MG: '31', PA: '15', PB: '25', PR: '41',
  PE: '26', PI: '22', RJ: '33', RN: '24', RS: '43', RO: '11', RR: '14', SC: '42',
  SP: '35', SE: '28', TO: '17'
};

const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const money = (v) => Number(v || 0).toFixed(2);            // ABRASF: decimal com ponto, 2 casas
const trim = (v) => String(v == null ? '' : v).trim();

// escapa texto para conteúdo XML
const esc = (v) => trim(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// código IBGE (7 díg) do município do tomador a partir de UF + A1_COD_MUN (Protheus
// guarda só os 5 últimos dígitos). Ex.: BA + 27408 = 2927408 (Salvador).
function ibgeMunicipio(uf, codMun) {
  const pref = IBGE_UF[trim(uf).toUpperCase()];
  const c = soDig(codMun);
  if (!pref || c.length < 4) return '';
  return pref + c.padStart(5, '0').slice(-5);
}

// Id do RPS usado na assinatura (Reference URI="#<id>"). Só alfanumérico.
function idRps(numero, serie) {
  return 'rps' + soDig(numero) + trim(serie).replace(/[^A-Za-z0-9]/g, '');
}

// Monta o bloco <Servico> (ABRASF 2.03). aliquota em % (ex.: 2 => 2.00 e ISS = base*2/100).
function blocoServico(nota, cfg) {
  const valorServicos = Number(nota.valorServicos || 0);
  const aliquota = Number(nota.aliquota != null ? nota.aliquota : cfg.aliquotaPadrao || 0);
  const issRetido = nota.issRetido ? 1 : 2;                 // 1=Sim, 2=Não
  const valorIss = +(valorServicos * aliquota / 100).toFixed(2);
  const item = trim(nota.itemListaServico || cfg.itemListaServicoPadrao);   // LC116 ex.: "01.07"
  const codTrib = trim(nota.codigoTributacaoMunicipio || cfg.codigoTributacaoPadrao || '');
  const munIncidencia = trim(cfg.codigoMunicipioPrestador);  // Barretos 3505500 (incidência do ISS)

  return `<Servico>` +
    `<Valores>` +
      `<ValorServicos>${money(valorServicos)}</ValorServicos>` +
      `<ValorDeducoes>0.00</ValorDeducoes>` +
      `<ValorIss>${money(valorIss)}</ValorIss>` +
      `<Aliquota>${money(aliquota)}</Aliquota>` +
      `<DescontoIncondicionado>0.00</DescontoIncondicionado>` +
      `<DescontoCondicionado>0.00</DescontoCondicionado>` +
    `</Valores>` +
    `<IssRetido>${issRetido}</IssRetido>` +
    `<ItemListaServico>${esc(item)}</ItemListaServico>` +
    (codTrib ? `<CodigoTributacaoMunicipio>${esc(codTrib)}</CodigoTributacaoMunicipio>` : '') +
    `<Discriminacao>${esc(nota.discriminacao)}</Discriminacao>` +
    `<CodigoMunicipio>${esc(munIncidencia)}</CodigoMunicipio>` +
    `<ExigibilidadeISS>1</ExigibilidadeISS>` +
    `<MunicipioIncidencia>${esc(munIncidencia)}</MunicipioIncidencia>` +
  `</Servico>`;
}

function blocoPrestador(cfg) {
  return `<Prestador>` +
    `<CpfCnpj><Cnpj>${soDig(cfg.cnpjPrestador)}</Cnpj></CpfCnpj>` +
    `<InscricaoMunicipal>${esc(cfg.inscricaoMunicipalPrestador)}</InscricaoMunicipal>` +
  `</Prestador>`;
}

function blocoTomador(t) {
  const doc = soDig(t.cpfCnpj);
  const tagDoc = doc.length === 11 ? `<Cpf>${doc}</Cpf>` : `<Cnpj>${doc}</Cnpj>`;
  const ibge = t.codMunicipioIbge || ibgeMunicipio(t.uf, t.codMunicipio);
  const partes = [];
  partes.push(`<IdentificacaoTomador><CpfCnpj>${tagDoc}</CpfCnpj>` +
    (trim(t.inscricaoMunicipal) ? `<InscricaoMunicipal>${esc(t.inscricaoMunicipal)}</InscricaoMunicipal>` : '') +
    `</IdentificacaoTomador>`);
  partes.push(`<RazaoSocial>${esc(t.razaoSocial)}</RazaoSocial>`);
  partes.push(`<Endereco>` +
    `<Endereco>${esc(t.endereco)}</Endereco>` +
    `<Numero>${esc(t.numero || 'S/N')}</Numero>` +
    (trim(t.complemento) ? `<Complemento>${esc(t.complemento)}</Complemento>` : '') +
    `<Bairro>${esc(t.bairro)}</Bairro>` +
    `<CodigoMunicipio>${esc(ibge)}</CodigoMunicipio>` +
    `<Uf>${esc(t.uf)}</Uf>` +
    `<Cep>${soDig(t.cep)}</Cep>` +
  `</Endereco>`);
  if (trim(t.email)) partes.push(`<Contato><Email>${esc(t.email)}</Email></Contato>`);
  return `<Tomador>${partes.join('')}</Tomador>`;
}

// Monta o <GerarNfseEnvio> (sem assinatura). Retorna { xml, id }.
// `id` é o Id do InfDeclaracaoPrestacaoServico p/ a assinatura referenciar.
function montarGerarNfse(nota, cfg) {
  const id = idRps(nota.rps.numero, nota.rps.serie);
  const inf =
    `<InfDeclaracaoPrestacaoServico Id="${id}">` +
      `<Rps>` +
        `<IdentificacaoRps>` +
          `<Numero>${soDig(nota.rps.numero)}</Numero>` +
          `<Serie>${esc(nota.rps.serie)}</Serie>` +
          `<Tipo>${nota.rps.tipo || 1}</Tipo>` +
        `</IdentificacaoRps>` +
        `<DataEmissao>${esc(nota.dataEmissao)}</DataEmissao>` +
        `<Status>1</Status>` +
      `</Rps>` +
      `<Competencia>${esc(nota.competencia || nota.dataEmissao)}</Competencia>` +
      blocoServico(nota, cfg) +
      blocoPrestador(cfg) +
      blocoTomador(nota.tomador) +
      `<OptanteSimplesNacional>${cfg.optanteSimplesNacional || 2}</OptanteSimplesNacional>` +
      `<IncentivoFiscal>${cfg.incentivoFiscal || 2}</IncentivoFiscal>` +
    `</InfDeclaracaoPrestacaoServico>`;

  const xml =
    `<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">` +
      `<Rps>${inf}</Rps>` +
    `</GerarNfseEnvio>`;
  return { xml, id };
}

module.exports = { montarGerarNfse, ibgeMunicipio, idRps, IBGE_UF };

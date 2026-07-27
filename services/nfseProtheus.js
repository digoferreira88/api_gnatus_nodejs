// services/nfseProtheus.js — lê uma NF de serviço (série C) do Protheus e normaliza
// para o formato "nota" que o gerador ABRASF (services/nfseXml.js) consome.
//
// READ-ONLY no Protheus. Fonte: SF2010 (cabeçalho) + SD2010 (itens) + SA1010 (tomador)
// + SB1010 (produto/serviço, p/ descrição e futuro de-para LC116 em B1_CODISS).
//
// ⚠️ ISS vem ZERADO no Protheus (calculado hoje na emissão manual do portal); a
// alíquota/LC116 entram pela config/de-para fiscal, não daqui.

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

// YYYYMMDD -> YYYY-MM-DD
function dataIso(ymd) {
  const s = trim(ymd).replace(/\D/g, '');
  if (s.length !== 8) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// Best-effort: separa "RUA X, 123" em { endereco:'RUA X', numero:'123' }. Sem número
// reconhecível → numero 'S/N'. Protheus guarda tudo em A1_END.
function splitEndereco(a1end) {
  const s = trim(a1end);
  const m = s.match(/^(.*?)[,\s]+(\d+[A-Za-z]?)\s*$/);
  if (m) return { endereco: trim(m[1]).replace(/,\s*$/, ''), numero: m[2] };
  return { endereco: s, numero: 'S/N' };
}

// Busca UMA nota de serviço e normaliza. Retorna null se não achar.
async function buscarNotaServico(Protheus, { serie = 'C', doc, cliente, loja }) {
  const hdr = await Protheus.connectAndQuery(
    `SELECT TOP 1 RTRIM(F2_DOC) doc, RTRIM(F2_SERIE) serie, F2_EMISSAO emissao,
            RTRIM(F2_CLIENTE) cliente, RTRIM(F2_LOJA) loja, F2_VALBRUT valbrut
       FROM SF2010 WITH (NOLOCK)
      WHERE D_E_L_E_T_ <> '*' AND F2_SERIE = @serie AND RTRIM(F2_DOC) = @doc
        AND F2_CLIENTE = @cliente AND F2_LOJA = @loja`,
    { serie, doc: trim(doc), cliente: trim(cliente), loja: trim(loja) });
  if (!hdr.length) return null;
  const h = hdr[0];

  const sa1 = await Protheus.connectAndQuery(
    `SELECT RTRIM(A1_NOME) nome, RTRIM(A1_CGC) cgc, RTRIM(A1_PESSOA) pessoa,
            RTRIM(A1_END) endereco, RTRIM(A1_BAIRRO) bairro, RTRIM(A1_COD_MUN) codmun,
            RTRIM(A1_EST) uf, RTRIM(A1_CEP) cep, RTRIM(A1_INSCRM) im, RTRIM(A1_EMAIL) email
       FROM SA1010 WITH (NOLOCK)
      WHERE D_E_L_E_T_ <> '*' AND A1_COD = @c AND A1_LOJA = @l`,
    { c: h.cliente, l: h.loja });
  const t = sa1[0] || {};

  const itensRows = await Protheus.connectAndQuery(
    `SELECT RTRIM(d2.D2_ITEM) item, RTRIM(d2.D2_COD) cod, d2.D2_QUANT quant, d2.D2_TOTAL total,
            RTRIM(sb1.B1_DESC) descricao, RTRIM(sb1.B1_CODISS) codiss, RTRIM(sb1.B1_TIPO) tipo
       FROM SD2010 d2 WITH (NOLOCK)
       LEFT JOIN SB1010 sb1 WITH (NOLOCK) ON sb1.B1_COD = d2.D2_COD AND sb1.D_E_L_E_T_ <> '*'
      WHERE d2.D_E_L_E_T_ <> '*' AND d2.D2_SERIE = @serie AND RTRIM(d2.D2_DOC) = @doc
        AND d2.D2_CLIENTE = @c AND d2.D2_LOJA = @l
      ORDER BY d2.D2_ITEM`,
    { serie, doc: h.doc, c: h.cliente, l: h.loja });

  const itens = itensRows.map(r => ({
    codigo: trim(r.cod), descricao: trim(r.descricao), quantidade: N(r.quant),
    valorTotal: N(r.total), itemListaServico: trim(r.codiss)   // B1_CODISS (hoje vazio → de-para)
  }));

  const end = splitEndereco(t.endereco);
  const discriminacao = itens.map(i =>
    `${i.descricao}${i.quantidade > 1 ? ` (${i.quantidade}x)` : ''} - R$ ${N(i.valorTotal).toFixed(2)}`
  ).join(' | ');

  // item LC116 da nota: usa o do 1º item que tiver de-para preenchido (senão vazio → cai no padrão da config)
  const itemLC116 = itens.map(i => i.itemListaServico).find(Boolean) || '';

  return {
    origem: { filial: '01', serie: h.serie, doc: h.doc, cliente: h.cliente, loja: h.loja },
    rps: { numero: h.doc, serie: h.serie, tipo: 1 },
    dataEmissao: dataIso(h.emissao),
    competencia: dataIso(h.emissao),
    valorServicos: N(h.valbrut),
    itemListaServico: itemLC116,
    discriminacao,
    itens,
    tomador: {
      cpfCnpj: trim(t.cgc),
      tipoPessoa: trim(t.pessoa) || (trim(t.cgc).replace(/\D/g, '').length === 11 ? 'F' : 'J'),
      razaoSocial: trim(t.nome),
      endereco: end.endereco, numero: end.numero,
      bairro: trim(t.bairro), uf: trim(t.uf), codMunicipio: trim(t.codmun),
      cep: trim(t.cep), inscricaoMunicipal: trim(t.im),
      email: trim(t.email).split(/[;,\s]+/).filter(Boolean)[0] || ''   // 1º e-mail (A1_EMAIL pode ter vários)
    }
  };
}

// Lista as notas de serviço (série C) faturadas num período — p/ o scheduler varrer.
async function listarNotasServicoPeriodo(Protheus, { serie = 'C', inicio, fim }) {
  return await Protheus.connectAndQuery(
    `SELECT RTRIM(F2_DOC) doc, RTRIM(F2_SERIE) serie, RTRIM(F2_CLIENTE) cliente,
            RTRIM(F2_LOJA) loja, F2_EMISSAO emissao, F2_VALBRUT valbrut
       FROM SF2010 WITH (NOLOCK)
      WHERE D_E_L_E_T_ <> '*' AND F2_SERIE = @serie AND F2_EMISSAO BETWEEN @inicio AND @fim
      ORDER BY F2_DOC`,
    { serie, inicio: trim(inicio), fim: trim(fim) });
}

module.exports = { buscarNotaServico, listarNotasServicoPeriodo, splitEndereco, dataIso };

// DANFE espelho — gera HTML printable do DANFE a partir dos dados do Protheus
// (SF2/SD2 ou SF1/SD1). NAO é o DANFE oficial — destinado a consulta interna do
// SAC. Visualmente parecido com o DANFE pra facilitar conferencia, com cabecalho
// destacado avisando que nao substitui o documento fiscal.
//
// O usuario abre no browser e usa Ctrl+P pra salvar como PDF se quiser.
//
// Query: doc, serie, tipo (saida|entrada). Mesmos parametros do /sac/nota.

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

const fmtNum = (n, dec = 2) => Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fmtMoney = (n) => fmtNum(n, 2);
const fmtData = (s) => s && s.length === 8 ? `${s.slice(6,8)}/${s.slice(4,6)}/${s.slice(0,4)}` : (s || '');
const fmtCnpj = (s) => {
  s = String(s || '').replace(/\D/g, '');
  if (s.length === 14) return `${s.slice(0,2)}.${s.slice(2,5)}.${s.slice(5,8)}/${s.slice(8,12)}-${s.slice(12,14)}`;
  if (s.length === 11) return `${s.slice(0,3)}.${s.slice(3,6)}.${s.slice(6,9)}-${s.slice(9,11)}`;
  return s;
};
const fmtChave = (s) => {
  s = String(s || '').replace(/\D/g, '');
  return s.match(/.{1,4}/g)?.join(' ') || s;
};
const esc = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Perm ampliada 04/09/2026: além do SAC (6001/6002), Expedição (12001),
// Contas a Receber (8002) e Fiscal (16001) — o DANFE espelho lê só SF2/SD2
// (dados que essas telas já mostram) e ajuda a conferência/financeiro enquanto
// o Transmite está instável.
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6001, 6002, 12001, 8002, 16001]);

module.exports = (app) => ({
  verb: 'get',
  route: '/nota/danfe',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const doc = trim(req.query.doc);
    const serie = trim(req.query.serie);
    const tipo = (trim(req.query.tipo) || 'saida').toLowerCase();

    if (!doc) return res.status(400).send('Parametro doc obrigatorio.');

    const params = { doc, serie };
    const cabSql = tipo === 'entrada'
      ? `SELECT RTRIM(f1.F1_DOC) numero, RTRIM(f1.F1_SERIE) serie, f1.F1_EMISSAO emissao,
                RTRIM(f1.F1_TIPO) tipo, RTRIM(f1.F1_ESPECIE) especie,
                RTRIM(f1.F1_CHVNFE) chaveNFe, RTRIM(f1.F1_STATUS) status,
                RTRIM(f1.F1_FORNECE) cod, RTRIM(f1.F1_LOJA) loja,
                RTRIM(sa1.A1_NOME) nome, RTRIM(sa1.A1_NREDUZ) nomeRed,
                RTRIM(sa1.A1_CGC) cgc, RTRIM(sa1.A1_INSCR) ie,
                RTRIM(sa1.A1_END) endereco, RTRIM(sa1.A1_BAIRRO) bairro,
                RTRIM(sa1.A1_MUN) municipio, RTRIM(sa1.A1_EST) estado,
                RTRIM(sa1.A1_CEP) cep, RTRIM(sa1.A1_TEL) telefone, RTRIM(sa1.A1_EMAIL) email,
                f1.F1_VALBRUT valBruto, f1.F1_VALMERC valMerc,
                f1.F1_VALICM valICMS, f1.F1_BASEICM bcICMS,
                f1.F1_VALIPI valIPI, f1.F1_FRETE frete, f1.F1_SEGURO seguro,
                f1.F1_DESPESA despesa, f1.F1_DESCONT desconto,
                RTRIM(f1.F1_COND) condPag, RTRIM(e4.E4_DESCRI) condPagDesc,
                RTRIM(f1.F1_NFORIG) ntOrig, RTRIM(f1.F1_SERORIG) serOrig
           FROM SF1010 f1 WITH (NOLOCK)
           LEFT JOIN SA1010 sa1 WITH (NOLOCK)
             ON sa1.A1_COD = f1.F1_FORNECE AND sa1.A1_LOJA = f1.F1_LOJA AND sa1.D_E_L_E_T_ <> '*'
           LEFT JOIN SE4010 e4 WITH (NOLOCK) ON e4.E4_CODIGO = f1.F1_COND AND e4.D_E_L_E_T_ <> '*'
          WHERE f1.D_E_L_E_T_ <> '*' AND RTRIM(f1.F1_DOC) = @doc
            ${serie ? 'AND RTRIM(f1.F1_SERIE) = @serie' : ''}`
      : `SELECT RTRIM(f2.F2_DOC) numero, RTRIM(f2.F2_SERIE) serie, f2.F2_EMISSAO emissao,
                RTRIM(f2.F2_TIPO) tipo, RTRIM(f2.F2_ESPECIE) especie,
                RTRIM(f2.F2_CHVNFE) chaveNFe, RTRIM(f2.F2_STATUS) status,
                RTRIM(f2.F2_CLIENTE) cod, RTRIM(f2.F2_LOJA) loja,
                RTRIM(sa1.A1_NOME) nome, RTRIM(sa1.A1_NREDUZ) nomeRed,
                RTRIM(sa1.A1_CGC) cgc, RTRIM(sa1.A1_INSCR) ie,
                RTRIM(sa1.A1_END) endereco, RTRIM(sa1.A1_BAIRRO) bairro,
                RTRIM(sa1.A1_MUN) municipio, RTRIM(sa1.A1_EST) estado,
                RTRIM(sa1.A1_CEP) cep, RTRIM(sa1.A1_TEL) telefone, RTRIM(sa1.A1_EMAIL) email,
                f2.F2_VALBRUT valBruto, f2.F2_VALMERC valMerc,
                f2.F2_VALICM valICMS, f2.F2_BASEICM bcICMS,
                f2.F2_VALIPI valIPI, f2.F2_FRETE frete, f2.F2_SEGURO seguro,
                f2.F2_DESPESA despesa, f2.F2_DESCONT desconto,
                RTRIM(f2.F2_COND) condPag, RTRIM(e4.E4_DESCRI) condPagDesc,
                RTRIM(f2.F2_TRANSP) transp, RTRIM(sa4.A4_NOME) transpNome,
                RTRIM(sa4.A4_CGC) transpCgc, RTRIM(sa4.A4_END) transpEnd,
                RTRIM(sa4.A4_MUN) transpMun, RTRIM(sa4.A4_EST) transpEst
           FROM SF2010 f2 WITH (NOLOCK)
           LEFT JOIN SA1010 sa1 WITH (NOLOCK)
             ON sa1.A1_COD = f2.F2_CLIENTE AND sa1.A1_LOJA = f2.F2_LOJA AND sa1.D_E_L_E_T_ <> '*'
           LEFT JOIN SE4010 e4 WITH (NOLOCK) ON e4.E4_CODIGO = f2.F2_COND AND e4.D_E_L_E_T_ <> '*'
           LEFT JOIN SA4010 sa4 WITH (NOLOCK) ON sa4.A4_COD = f2.F2_TRANSP AND sa4.D_E_L_E_T_ <> '*'
          WHERE f2.D_E_L_E_T_ <> '*' AND RTRIM(f2.F2_DOC) = @doc
            ${serie ? 'AND RTRIM(f2.F2_SERIE) = @serie' : ''}`;

    const itensSql = tipo === 'entrada'
      ? `SELECT RTRIM(d1.D1_ITEM) item, RTRIM(d1.D1_COD) cod, RTRIM(sb1.B1_DESC) descricao,
                RTRIM(d1.D1_UM) um, RTRIM(d1.D1_CF) cfop,
                d1.D1_QUANT quant, d1.D1_VUNIT vunit, d1.D1_TOTAL total,
                d1.D1_VALICM valICM, d1.D1_PICM aliqICM,
                d1.D1_VALIPI valIPI, d1.D1_IPI aliqIPI
           FROM SD1010 d1 WITH (NOLOCK)
           LEFT JOIN SB1010 sb1 WITH (NOLOCK) ON sb1.B1_COD = d1.D1_COD AND sb1.D_E_L_E_T_ <> '*'
          WHERE d1.D_E_L_E_T_ <> '*' AND RTRIM(d1.D1_DOC) = @doc
            ${serie ? 'AND RTRIM(d1.D1_SERIE) = @serie' : ''}
          ORDER BY d1.D1_ITEM`
      : `SELECT RTRIM(d2.D2_ITEM) item, RTRIM(d2.D2_COD) cod, RTRIM(sb1.B1_DESC) descricao,
                RTRIM(d2.D2_UM) um, RTRIM(d2.D2_CF) cfop,
                d2.D2_QUANT quant, d2.D2_PRCVEN vunit, d2.D2_TOTAL total,
                d2.D2_VALICM valICM, d2.D2_PICM aliqICM,
                d2.D2_VALIPI valIPI, d2.D2_IPI aliqIPI
           FROM SD2010 d2 WITH (NOLOCK)
           LEFT JOIN SB1010 sb1 WITH (NOLOCK) ON sb1.B1_COD = d2.D2_COD AND sb1.D_E_L_E_T_ <> '*'
          WHERE d2.D_E_L_E_T_ <> '*' AND RTRIM(d2.D2_DOC) = @doc
            ${serie ? 'AND RTRIM(d2.D2_SERIE) = @serie' : ''}
          ORDER BY d2.D2_ITEM`;

    try {
      const [headerRows, itens] = await Promise.all([
        Protheus.connectAndQuery(cabSql, params),
        Protheus.connectAndQuery(itensSql, params)
      ]);

      if (!headerRows.length) return res.status(404).send('Nota nao encontrada.');

      const h = headerRows[0];
      const html = renderDanfe({
        tipo,
        numero: trim(h.numero), serie: trim(h.serie),
        emissao: fmtData(trim(h.emissao)),
        especie: trim(h.especie), tipoNF: trim(h.tipo),
        chave: trim(h.chaveNFe), status: trim(h.status),
        destinatario: {
          nome: trim(h.nome).replace(/^[:.\s]+/, ''),
          cgc: fmtCnpj(trim(h.cgc)),
          ie: trim(h.ie),
          endereco: trim(h.endereco),
          bairro: trim(h.bairro),
          cep: trim(h.cep),
          municipio: trim(h.municipio),
          estado: trim(h.estado),
          telefone: trim(h.telefone),
          email: trim(h.email),
          codLoja: `${trim(h.cod)}/${trim(h.loja)}`
        },
        totais: {
          valBruto: toN(h.valBruto), valMerc: toN(h.valMerc),
          bcICMS: toN(h.bcICMS), valICMS: toN(h.valICMS),
          valIPI: toN(h.valIPI), frete: toN(h.frete),
          seguro: toN(h.seguro), despesa: toN(h.despesa),
          desconto: toN(h.desconto)
        },
        condPag: trim(h.condPag), condPagDesc: trim(h.condPagDesc),
        transp: trim(h.transp || ''), transpNome: trim(h.transpNome || ''),
        transpCgc: fmtCnpj(trim(h.transpCgc || '')),
        transpEnd: trim(h.transpEnd || ''),
        transpMun: trim(h.transpMun || ''), transpEst: trim(h.transpEst || ''),
        itens: itens.map(i => ({
          item: trim(i.item), cod: trim(i.cod), descricao: trim(i.descricao),
          um: trim(i.um), cfop: trim(i.cfop),
          quant: toN(i.quant), vunit: toN(i.vunit), total: toN(i.total),
          valICM: toN(i.valICM), aliqICM: toN(i.aliqICM),
          valIPI: toN(i.valIPI), aliqIPI: toN(i.aliqIPI)
        }))
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    } catch (err) {
      console.error('Erro sac/nota/danfe:', err);
      return res.status(500).send('Erro ao gerar DANFE espelho: ' + err.message);
    }
  }
});

// ============== Renderiza HTML do DANFE espelho ==============

const EMITENTE = {
  razao: 'GNATUS EQUIPAMENTOS MEDICO-ODONTOLOGICOS LTDA',
  fantasia: 'GNATUS',
  cnpj: '09.609.356/0001-00',
  ie: '587.041.247.115',
  endereco: 'Rod. Abrao Assed, KM 53+450m',
  bairro: 'Recreio Anhanguera',
  cep: '14097-500',
  municipio: 'Ribeirao Preto',
  uf: 'SP',
  telefone: '(16) 2102-5000'
};

function renderDanfe(d) {
  const emit = EMITENTE;
  const subtotal = (d.totais.valMerc || 0);
  const totalNF = subtotal + (d.totais.valIPI || 0) + (d.totais.frete || 0)
                + (d.totais.seguro || 0) + (d.totais.despesa || 0) - (d.totais.desconto || 0);

  const linhasItens = d.itens.map(i => `
    <tr>
      <td class="mono">${esc(i.cod)}</td>
      <td>${esc(i.descricao)}</td>
      <td class="center">${esc(i.cfop)}</td>
      <td class="center">${esc(i.um)}</td>
      <td class="right">${fmtNum(i.quant, 2)}</td>
      <td class="right">${fmtMoney(i.vunit)}</td>
      <td class="right b">${fmtMoney(i.total)}</td>
      <td class="right">${fmtMoney(i.valICM)}</td>
      <td class="right">${fmtNum(i.aliqICM, 2)}%</td>
      <td class="right">${fmtMoney(i.valIPI)}</td>
    </tr>
  `).join('');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>DANFE Espelho ${esc(d.numero)}/${esc(d.serie)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; background: #eef0f3; padding: 16px; color: #1a2740; font-size: 11px; }
  .pagina { max-width: 920px; margin: 0 auto; background: #fff; padding: 14px 16px; box-shadow: 0 4px 16px rgba(0,0,0,.1); }
  .alerta { background: #fff3e0; border: 2px solid #c9302c; color: #8a1f1b; padding: 10px 14px; margin-bottom: 12px; border-radius: 6px; font-size: 12px; }
  .alerta strong { display: block; font-size: 13px; margin-bottom: 2px; }
  .toolbar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 10px; }
  .toolbar button { padding: 8px 18px; background: #1a3f82; color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-weight: 700; font-size: 12px; }
  .toolbar button:hover { background: #1e5fb5; }

  .secao { border: 1px solid #1a2740; margin-bottom: 4px; }
  .secao-titulo { background: #1a2740; color: #fff; padding: 3px 8px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 700; }
  .row { display: flex; }
  .col { flex: 1; padding: 4px 8px; border-right: 1px solid #1a2740; }
  .col:last-child { border-right: 0; }
  .col label { font-size: 8px; text-transform: uppercase; color: #6b7a90; font-weight: 700; display: block; }
  .col .v { font-size: 11px; color: #1a2740; font-weight: 600; min-height: 14px; }
  .col.tight { flex: 0 0 auto; }

  .header { display: grid; grid-template-columns: 2fr 1fr 1.5fr; border: 1px solid #1a2740; }
  .header > div { padding: 6px 8px; border-right: 1px solid #1a2740; }
  .header > div:last-child { border-right: 0; }
  .header .emit-razao { font-weight: 800; font-size: 13px; margin-bottom: 4px; }
  .header .emit-end { font-size: 10px; color: #1a2740; line-height: 1.4; }
  .header .danfe-titulo { text-align: center; }
  .header .danfe-titulo .l { font-size: 11px; font-weight: 700; }
  .header .danfe-titulo .nf { font-size: 22px; font-weight: 800; margin-top: 4px; }
  .header .danfe-titulo .sn { font-size: 11px; }
  .header .chave { font-size: 9px; word-break: break-all; }
  .header .chave .l { font-size: 8px; color: #6b7a90; text-transform: uppercase; font-weight: 700; }
  .header .chave .v { font-family: 'Consolas', monospace; font-weight: 700; letter-spacing: 1px; margin-top: 2px; }

  table.itens { width: 100%; border-collapse: collapse; border: 1px solid #1a2740; margin-bottom: 4px; }
  table.itens thead th { background: #1a2740; color: #fff; padding: 4px 6px; font-size: 9px; text-transform: uppercase; font-weight: 700; }
  table.itens tbody td { padding: 3px 6px; border-bottom: 1px dotted #999; font-size: 10px; }
  table.itens tbody tr:nth-child(even) { background: #f7f9fc; }
  .center { text-align: center; }
  .right { text-align: right; }
  .b { font-weight: 700; }
  .mono { font-family: 'Consolas', monospace; }

  .totais { display: grid; grid-template-columns: repeat(8, 1fr); border: 1px solid #1a2740; }
  .totais > div { padding: 4px 6px; border-right: 1px solid #1a2740; }
  .totais > div:last-child { border-right: 0; }
  .totais label { font-size: 8px; color: #6b7a90; text-transform: uppercase; font-weight: 700; display: block; }
  .totais .v { font-size: 11px; font-weight: 700; text-align: right; }
  .totais .total-nf .v { font-size: 13px; color: #1a3f82; }

  .obs { border: 1px solid #1a2740; padding: 6px 8px; min-height: 50px; font-size: 10px; }
  .obs label { font-size: 8px; text-transform: uppercase; color: #6b7a90; font-weight: 700; }

  .footer { margin-top: 12px; padding-top: 10px; border-top: 1px dashed #999; text-align: center; color: #6b7a90; font-size: 9px; }

  /* Print */
  @media print {
    body { background: #fff; padding: 0; }
    .pagina { box-shadow: none; padding: 8px 12px; }
    .toolbar { display: none; }
    .alerta { background: transparent; border: 2px solid #c9302c; }
  }
</style>
</head>
<body>

<div class="pagina">
  <div class="toolbar">
    <button onclick="window.print()">🖨️ Imprimir / Salvar PDF</button>
  </div>

  <div class="alerta">
    <strong>⚠️ DOCUMENTO DE CONSULTA INTERNA — NÃO É O DANFE OFICIAL</strong>
    Espelho informativo gerado pela Intranet GNATUS a partir dos dados do Protheus.
    Não substitui o DANFE oficial nem possui validade fiscal. Para o DANFE original, consulte o portal SEFAZ pela chave de acesso.
  </div>

  <div class="header">
    <div>
      <div class="emit-razao">${esc(emit.razao)}</div>
      <div class="emit-end">
        ${esc(emit.endereco)}<br>
        ${esc(emit.bairro)} - ${esc(emit.municipio)}/${esc(emit.uf)} - CEP ${esc(emit.cep)}<br>
        Fone: ${esc(emit.telefone)}<br>
        CNPJ: ${esc(emit.cnpj)} · IE: ${esc(emit.ie)}
      </div>
    </div>
    <div class="danfe-titulo">
      <div class="l">DANFE</div>
      <div class="l" style="font-size:9px;color:#6b7a90;">Documento Auxiliar da Nota Fiscal Eletrônica</div>
      <div class="nf">Nº ${esc(d.numero)}</div>
      <div class="sn">SÉRIE ${esc(d.serie)}</div>
      <div class="sn" style="margin-top:4px;font-size:9px;color:#6b7a90;">${d.tipo === 'entrada' ? '0 - ENTRADA' : '1 - SAÍDA'}</div>
    </div>
    <div>
      <div class="chave">
        <div class="l">CHAVE DE ACESSO</div>
        <div class="v">${esc(fmtChave(d.chave))}</div>
      </div>
      <div style="margin-top:6px;font-size:9px;">
        <strong>Emissão:</strong> ${esc(d.emissao)}<br>
        <strong>Espécie:</strong> ${esc(d.especie || 'NF')}<br>
        <strong>Status SEFAZ:</strong> ${esc(d.status || '—')}
      </div>
    </div>
  </div>

  <div class="secao">
    <div class="secao-titulo">${d.tipo === 'entrada' ? 'Remetente' : 'Destinatário'} / Cliente ${esc(d.destinatario.codLoja)}</div>
    <div class="row">
      <div class="col" style="flex: 2"><label>Razão Social</label><div class="v">${esc(d.destinatario.nome)}</div></div>
      <div class="col"><label>CNPJ/CPF</label><div class="v mono">${esc(d.destinatario.cgc)}</div></div>
      <div class="col"><label>IE</label><div class="v mono">${esc(d.destinatario.ie || '—')}</div></div>
    </div>
    <div class="row">
      <div class="col" style="flex: 2"><label>Endereço</label><div class="v">${esc(d.destinatario.endereco || '—')}</div></div>
      <div class="col"><label>Bairro</label><div class="v">${esc(d.destinatario.bairro || '—')}</div></div>
      <div class="col"><label>CEP</label><div class="v mono">${esc(d.destinatario.cep || '—')}</div></div>
    </div>
    <div class="row">
      <div class="col"><label>Município</label><div class="v">${esc(d.destinatario.municipio)}</div></div>
      <div class="col tight" style="min-width: 60px;"><label>UF</label><div class="v">${esc(d.destinatario.estado)}</div></div>
      <div class="col"><label>Telefone</label><div class="v">${esc(d.destinatario.telefone || '—')}</div></div>
      <div class="col" style="flex: 2"><label>E-mail</label><div class="v">${esc(d.destinatario.email || '—')}</div></div>
    </div>
  </div>

  ${d.tipo !== 'entrada' && d.transp ? `
  <div class="secao">
    <div class="secao-titulo">Transportadora</div>
    <div class="row">
      <div class="col" style="flex: 2"><label>Razão Social</label><div class="v">${esc(d.transpNome)}</div></div>
      <div class="col"><label>CNPJ/CPF</label><div class="v mono">${esc(d.transpCgc || '—')}</div></div>
    </div>
    <div class="row">
      <div class="col" style="flex: 2"><label>Endereço</label><div class="v">${esc(d.transpEnd || '—')}</div></div>
      <div class="col"><label>Município/UF</label><div class="v">${esc(d.transpMun || '—')}/${esc(d.transpEst || '—')}</div></div>
    </div>
  </div>
  ` : ''}

  <table class="itens">
    <thead>
      <tr>
        <th style="width: 80px;">Cód</th>
        <th>Descrição do Produto/Serviço</th>
        <th style="width: 50px;">CFOP</th>
        <th style="width: 40px;">UN</th>
        <th style="width: 70px;">Qtd</th>
        <th style="width: 80px;">Vlr Unit</th>
        <th style="width: 90px;">Vlr Total</th>
        <th style="width: 80px;">ICMS</th>
        <th style="width: 50px;">% ICMS</th>
        <th style="width: 80px;">IPI</th>
      </tr>
    </thead>
    <tbody>
      ${linhasItens || '<tr><td colspan="10" class="center" style="padding: 14px; color: #888;">Sem itens.</td></tr>'}
    </tbody>
  </table>

  <div class="totais">
    <div><label>BC ICMS</label><div class="v">${fmtMoney(d.totais.bcICMS)}</div></div>
    <div><label>Valor ICMS</label><div class="v">${fmtMoney(d.totais.valICMS)}</div></div>
    <div><label>Valor IPI</label><div class="v">${fmtMoney(d.totais.valIPI)}</div></div>
    <div><label>Frete</label><div class="v">${fmtMoney(d.totais.frete)}</div></div>
    <div><label>Seguro</label><div class="v">${fmtMoney(d.totais.seguro)}</div></div>
    <div><label>Despesas</label><div class="v">${fmtMoney(d.totais.despesa)}</div></div>
    <div><label>Desconto</label><div class="v">${fmtMoney(d.totais.desconto)}</div></div>
    <div class="total-nf"><label>Total da NF</label><div class="v">${fmtMoney(totalNF || d.totais.valBruto)}</div></div>
  </div>

  <div class="row" style="margin: 4px 0;">
    <div class="col" style="border: 1px solid #1a2740; flex: 1; padding: 4px 8px;">
      <label style="font-size:8px; text-transform:uppercase; color:#6b7a90; font-weight:700;">Cond. de Pagamento</label>
      <div class="v" style="font-size: 11px; font-weight: 600;">${esc(d.condPag)} - ${esc(d.condPagDesc || '—')}</div>
    </div>
    <div class="col" style="border: 1px solid #1a2740; border-left: 0; flex: 1; padding: 4px 8px;">
      <label style="font-size:8px; text-transform:uppercase; color:#6b7a90; font-weight:700;">Total de Itens</label>
      <div class="v" style="font-size: 11px; font-weight: 600;">${d.itens.length}</div>
    </div>
    <div class="col" style="border: 1px solid #1a2740; border-left: 0; flex: 1; padding: 4px 8px;">
      <label style="font-size:8px; text-transform:uppercase; color:#6b7a90; font-weight:700;">Total dos Produtos</label>
      <div class="v" style="font-size: 11px; font-weight: 600;">${fmtMoney(subtotal)}</div>
    </div>
  </div>

  <div class="footer">
    Gerado em ${new Date().toLocaleString('pt-BR')} pela Intranet GNATUS · Documento sem validade fiscal
  </div>
</div>

</body>
</html>`;
}

// Gerador de PDF do boleto bancario no layout Febraban 102.
//
// Replica o boleto que o Protheus gera pelo ESF050 (samples em
// docs/boleto-samples/santander.pdf e itau.pdf). Layout:
//
//   +---------------------------------------------+
//   |  [logo] 033-7              RECIBO DO PAGADOR |
//   |  tabela: local, venc, beneficiario, ag/cod,  |
//   |          data doc, num, especie, aceite,     |
//   |          processamento, nosso numero,        |
//   |          carteira, especie moeda, valor      |
//   |  pagador (nome + endereco + CNPJ)            |
//   |  mensagens (juros/multa)                     |
//   +- - - - - - corte na linha pontilhada - - - +
//   |  [logo] 033-7  <linha digitavel grande>     |
//   |  mesma tabela do recibo                      |
//   |  pagador + descontos/mora/valor cobrado      |
//   |  |||||||||||| (codigo de barras I2of5)        |
//   +---------------------------------------------+
//
// Uso:
//   const buf = await gerarBoletoPdf({
//     banco: '033',
//     beneficiario: { nome, cnpj, endereco },
//     pagador: { nome, cgc, endereco, bairro, municipio, uf, cep },
//     valor, vencimento,                   // valor R$, venc YYYYMMDD
//     numeroDocumento, dataDocumento,       // numero NF, emissao YYYYMMDD
//     nossoNumero, agencia, conta, carteira,
//     especieDoc,                            // 'DM' Santander, 'DMI' Itau
//     linhaDigitavel, codigoBarras,          // do Diego boleto-linha
//     instrucoes                             // array de strings, vai pro bloco "Instrucoes"
//   });
//   // buf eh Buffer com o PDF (1 pagina A4 retrato)

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');

// ============== Catalogo dos bancos suportados ==============
// Cor primaria pro fallback (sem logo PNG) e nome no campo "Local de Pagamento".
const BANCOS = {
  '033': { codigo: '033-7', nome: 'Santander', corFundo: '#EC0000', corTexto: '#FFFFFF', localPgto: 'PAGAVEL PREFERENCIALMENTE NO BANCO SANTANDER', aceite: 'NAO ACEITO' },
  '341': { codigo: '341-7', nome: 'Itau', corFundo: '#FF6900', corTexto: '#0033A0', localPgto: 'EM QUALQUER BANCO OU CORRESP. NAO BANCARIO', aceite: 'N' },
  '237': { codigo: '237-2', nome: 'Bradesco', corFundo: '#CC092F', corTexto: '#FFFFFF', localPgto: 'PAGAVEL EM QUALQUER BANCO', aceite: 'N' },
  '001': { codigo: '001-9', nome: 'Banco do Brasil', corFundo: '#FCEE21', corTexto: '#003DA5', localPgto: 'PAGAVEL EM QUALQUER BANCO', aceite: 'N' },
  '104': { codigo: '104-0', nome: 'Caixa', corFundo: '#0070AF', corTexto: '#FFFFFF', localPgto: 'PAGAVEL PREFERENCIALMENTE NAS CASAS LOTERICAS ATE O VALOR LIMITE', aceite: 'N' },
  '748': { codigo: '748-X', nome: 'Sicredi', corFundo: '#3FA535', corTexto: '#FFFFFF', localPgto: 'PAGAVEL EM QUALQUER BANCO', aceite: 'N' },
  '756': { codigo: '756-0', nome: 'Sicoob', corFundo: '#003641', corTexto: '#FFFFFF', localPgto: 'PAGAVEL EM QUALQUER BANCO', aceite: 'N' }
};

const ASSETS_BANCOS = path.join(__dirname, '..', 'assets', 'bancos');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

// ========== Helpers de formatacao ==========
function fmtData(v) {
  const s = trim(v).replace(/\D/g, '');
  if (s.length !== 8) return trim(v);
  return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
}
function fmtBRL(v) {
  return N(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtValor(v) {
  return N(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtCgc(v) {
  const s = trim(v).replace(/\D/g, '');
  if (s.length === 14) return `${s.slice(0,2)}.${s.slice(2,5)}.${s.slice(5,8)}/${s.slice(8,12)}-${s.slice(12)}`;
  if (s.length === 11) return `${s.slice(0,3)}.${s.slice(3,6)}.${s.slice(6,9)}-${s.slice(9)}`;
  return trim(v);
}
function fmtCep(v) {
  const s = trim(v).replace(/\D/g, '');
  if (s.length === 8) return `${s.slice(0,5)}-${s.slice(5)}`;
  return trim(v);
}
// Conta com DV: "12345-6"
function fmtContaDv(conta) {
  const s = trim(conta).replace(/\D/g, '');
  if (s.length < 2) return s;
  return `${s.slice(0, -1)}-${s.slice(-1)}`;
}

// ========== Codigo de barras I2of5 ==========
async function gerarCodigoBarras(codigo44) {
  const dig = trim(codigo44).replace(/\D/g, '');
  if (dig.length < 44) throw new Error(`codigo_barras invalido (${dig.length} digitos, esperado 44)`);
  // bwip-js sincrono via toBuffer; PNG preto e branco
  return await bwipjs.toBuffer({
    bcid: 'interleaved2of5',
    text: dig.slice(0, 44),
    scale: 2,
    height: 14,         // mm
    includetext: false, // sem texto debaixo (o boleto ja tem a linha digitavel)
    backgroundcolor: 'FFFFFF',
    paddingwidth: 0,
    paddingheight: 0
  });
}

// Carrega logo se existir em assets/bancos/<codigo>.png; senao retorna null
function carregarLogo(banco) {
  const p = path.join(ASSETS_BANCOS, `${trim(banco)}.png`);
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p);
  } catch (_) { /* ignore */ }
  return null;
}

// ========== Renderiza UM bloco (recibo ou ficha) ==========
function renderBloco(doc, opts, kind) {
  // kind = 'recibo' | 'ficha'
  const {
    banco, beneficiario, pagador, valor, vencimento,
    numeroDocumento, dataDocumento, nossoNumero,
    agencia, conta, carteira, especieDoc, linhaDigitavel,
    codigoBarrasPng, instrucoes
  } = opts;
  const meta = BANCOS[trim(banco)] || BANCOS['033'];

  const x0 = doc.x;
  const y0 = doc.y;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // ---- Header: logo + codigo + (titulo|linha digitavel) ----
  const HEADER_H = 28;
  const logoW = 90;

  // Caixa do logo
  const logo = carregarLogo(banco);
  if (logo) {
    try { doc.image(logo, x0, y0 + 2, { fit: [logoW, HEADER_H - 4] }); }
    catch (_) { drawLogoFallback(doc, x0, y0, logoW, HEADER_H, meta); }
  } else {
    drawLogoFallback(doc, x0, y0, logoW, HEADER_H, meta);
  }

  // Codigo do banco (033-7) em destaque
  const codX = x0 + logoW + 6;
  const codW = 50;
  doc.rect(codX, y0, codW, HEADER_H).lineWidth(1).strokeColor('#000').stroke();
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(14)
    .text(meta.codigo, codX, y0 + 7, { width: codW, align: 'center' });

  // Titulo ou linha digitavel a direita
  const rightX = codX + codW + 6;
  const rightW = (x0 + W) - rightX;
  if (kind === 'recibo') {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000')
      .text('RECIBO DO PAGADOR', rightX, y0 + 9, { width: rightW, align: 'right' });
  } else {
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000')
      .text(trim(linhaDigitavel), rightX, y0 + 9, { width: rightW, align: 'right' });
  }
  // Linha inferior do header
  doc.moveTo(x0, y0 + HEADER_H).lineTo(x0 + W, y0 + HEADER_H).lineWidth(1).strokeColor('#000').stroke();

  // ---- Tabela ----
  let y = y0 + HEADER_H;
  const drawCell = (x, yc, w, h, label, value, opts2 = {}) => {
    doc.rect(x, yc, w, h).lineWidth(0.5).strokeColor('#000').stroke();
    doc.font('Helvetica').fontSize(6).fillColor('#000').text(label || '', x + 2, yc + 1, { width: w - 4 });
    if (value !== undefined && value !== null) {
      doc.font(opts2.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts2.size || 9).fillColor('#000');
      const valStr = String(value);
      doc.text(valStr, x + 3, yc + 9, { width: w - 6, align: opts2.align || 'left', lineBreak: false });
    }
  };

  // Linha 1: Local Pagamento (75%) | Vencimento (25%)
  const wLocal = W * 0.75, wVenc = W - wLocal;
  drawCell(x0, y, wLocal, 26, 'Local de Pagamento', meta.localPgto, { bold: true, size: 8 });
  drawCell(x0 + wLocal, y, wVenc, 26, 'Vencimento', fmtData(vencimento), { bold: true, size: 11, align: 'right' });
  y += 26;

  // Linha 2: Beneficiario (75%) | Agencia/Cod. Beneficiario (25%)
  const benefStr = `${trim(beneficiario.nome)}${beneficiario.cnpj ? '  CNPJ ' + fmtCgc(beneficiario.cnpj) : ''}\n${trim(beneficiario.endereco || '')}`;
  doc.rect(x0, y, wLocal, 30).lineWidth(0.5).strokeColor('#000').stroke();
  doc.font('Helvetica').fontSize(6).fillColor('#000').text('Beneficiario', x0 + 2, y + 1);
  doc.font('Helvetica-Bold').fontSize(8).text(trim(beneficiario.nome), x0 + 3, y + 9, { width: wLocal - 6 });
  doc.font('Helvetica').fontSize(7.5).fillColor('#000')
    .text(`${beneficiario.cnpj ? 'CNPJ ' + fmtCgc(beneficiario.cnpj) + '   ' : ''}${trim(beneficiario.endereco || '')}`,
      x0 + 3, y + 19, { width: wLocal - 6, lineBreak: false });
  drawCell(x0 + wLocal, y, wVenc, 30, 'Agencia / Cod. Beneficiario', `${trim(agencia)} / ${trim(conta)}`, { bold: true, size: 10, align: 'right' });
  y += 30;

  // Linha 3: 5 colunas
  // Data Documento | No. Documento | Especie doc | Aceite | Data Processamento | Nosso Numero
  const c1w = W * 0.13, c2w = W * 0.13, c3w = W * 0.09, c4w = W * 0.09, c5w = W * 0.15, c6w = W - (c1w+c2w+c3w+c4w+c5w);
  let cx = x0;
  drawCell(cx, y, c1w, 22, 'Data do Documento', fmtData(dataDocumento), { bold: true, align: 'center', size: 9 }); cx += c1w;
  drawCell(cx, y, c2w, 22, 'No. do Documento', trim(numeroDocumento), { bold: true, align: 'center', size: 9 }); cx += c2w;
  drawCell(cx, y, c3w, 22, 'Especie doc.', trim(especieDoc) || 'DM', { bold: true, align: 'center', size: 9 }); cx += c3w;
  drawCell(cx, y, c4w, 22, 'Aceite', meta.aceite || 'N', { bold: true, align: 'center', size: 8 }); cx += c4w;
  drawCell(cx, y, c5w, 22, 'Data Processamento', fmtData(new Date().toISOString().slice(0, 10).replace(/-/g, '')), { bold: true, align: 'center', size: 9 }); cx += c5w;
  drawCell(cx, y, c6w, 22, 'Nosso Numero', trim(nossoNumero), { bold: true, align: 'right', size: 10 });
  y += 22;

  // Linha 4: Uso do Banco | Carteira | Especie Moeda | Quantidade | Valor | Valor do Documento
  cx = x0;
  drawCell(cx, y, c1w, 22, 'Uso do Banco', '', { align: 'center', size: 9 }); cx += c1w;
  drawCell(cx, y, c2w, 22, 'Carteira', trim(carteira) || '101', { bold: true, align: 'center', size: 9 }); cx += c2w;
  drawCell(cx, y, c3w, 22, 'Especie Moeda', 'REAL', { bold: true, align: 'center', size: 9 }); cx += c3w;
  drawCell(cx, y, c4w, 22, 'Quantidade', '', { align: 'center', size: 9 }); cx += c4w;
  drawCell(cx, y, c5w, 22, '(x) Valor', 'R$ 0,00', { bold: true, align: 'right', size: 9 }); cx += c5w;
  drawCell(cx, y, c6w, 22, '(=) Valor do Documento', fmtBRL(valor), { bold: true, align: 'right', size: 10 });
  y += 22;

  // Linha 5: Instrucoes (75%) | Descontos/Mora/Valor Cobrado (25%) — so na ficha
  const instH = kind === 'ficha' ? 76 : 52;
  doc.rect(x0, y, wLocal, instH).lineWidth(0.5).strokeColor('#000').stroke();
  doc.font('Helvetica').fontSize(6).fillColor('#000').text(kind === 'recibo' ? 'Mensagem / Instrucoes' : 'Instrucoes', x0 + 2, y + 1);
  doc.font('Helvetica').fontSize(8).fillColor('#000');
  let yIns = y + 10;
  (instrucoes || []).slice(0, 6).forEach(line => {
    if (!line) return;
    doc.text(trim(line), x0 + 3, yIns, { width: wLocal - 6, lineBreak: false });
    yIns += 10;
  });

  if (kind === 'ficha') {
    // (-) Descontos | (+) Mora/Multa | (=) Valor Cobrado — 3 linhas de 25pt
    let yE = y;
    ['(-) Descontos/Abatimento', '(+) Mora/Multa', '(=) Valor Cobrado'].forEach((lbl, i) => {
      doc.rect(x0 + wLocal, yE, wVenc, 25).lineWidth(0.5).strokeColor('#000').stroke();
      doc.font('Helvetica').fontSize(6).fillColor('#000').text(lbl, x0 + wLocal + 2, yE + 1);
      doc.font('Helvetica').fontSize(9).text(i === 0 ? 'R$ 0,00' : '', x0 + wLocal + 3, yE + 12, { width: wVenc - 6, align: 'right' });
      yE += 25;
    });
  } else {
    // No recibo, fica so 1 caixa "vazia" pra Demonstrativo
    doc.rect(x0 + wLocal, y, wVenc, instH).lineWidth(0.5).strokeColor('#000').stroke();
  }
  y += instH;

  // Linha 6: Pagador (full width)
  const pagH = 30;
  doc.rect(x0, y, W, pagH).lineWidth(0.5).strokeColor('#000').stroke();
  doc.font('Helvetica').fontSize(6).fillColor('#000').text('Pagador', x0 + 2, y + 1);
  doc.font('Helvetica-Bold').fontSize(9).text(
    `${trim(pagador.nome)}${pagador.cgc ? '   ' + fmtCgc(pagador.cgc) : ''}`,
    x0 + 3, y + 9, { width: W - 6, lineBreak: false });
  const endPag = [trim(pagador.endereco), trim(pagador.bairro), fmtCep(pagador.cep), trim(pagador.municipio), trim(pagador.uf)]
    .filter(Boolean).join(' - ');
  doc.font('Helvetica').fontSize(8).text(endPag, x0 + 3, y + 20, { width: W - 6, lineBreak: false });
  y += pagH;

  // Linha 7: Beneficiario Final (so label) + Autenticacao Mecanica a direita
  doc.rect(x0, y, W, 16).lineWidth(0.5).strokeColor('#000').stroke();
  doc.font('Helvetica').fontSize(6).fillColor('#000').text('Beneficiario Final', x0 + 2, y + 1);
  doc.font('Helvetica').fontSize(7).text('Autenticacao Mecanica', x0 + W - 110, y + 6, { width: 105, align: 'right' });
  y += 16;

  // ---- Codigo de barras (so na ficha) ----
  if (kind === 'ficha' && codigoBarrasPng) {
    try {
      doc.image(codigoBarrasPng, x0, y + 6, { width: 280, height: 40 });
    } catch (e) {
      doc.font('Helvetica').fontSize(8).fillColor('#c00')
        .text(`[falha ao desenhar codigo de barras: ${e.message}]`, x0, y + 6);
    }
  }
  y += 50;

  doc.y = y;
  return y;
}

// Logo "fallback" quando nao tem PNG: caixa colorida com nome
function drawLogoFallback(doc, x, y, w, h, meta) {
  doc.save();
  doc.rect(x, y, w, h).fill(meta.corFundo);
  doc.fillColor(meta.corTexto).font('Helvetica-Bold').fontSize(11);
  doc.text(meta.nome, x, y + 9, { width: w, align: 'center' });
  doc.restore();
}

// Linha pontilhada com texto "Corte na Linha Pontilhada"
function desenharCorte(doc, y) {
  const x0 = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.save();
  doc.dash(3, { space: 3 }).lineWidth(0.5).strokeColor('#666');
  doc.moveTo(x0, y).lineTo(x0 + W, y).stroke();
  doc.restore();
  doc.font('Helvetica').fontSize(7).fillColor('#666')
    .text('Corte na Linha Pontilhada', x0, y - 9, { width: W, align: 'right' });
}

// Monta o array de instrucoes a partir dos dados do SE1 (juros R$/dia, multa %)
function montarInstrucoes({ jurosDia, multaPct, valor, vencimento, extras }) {
  const out = [];
  if (jurosDia && jurosDia > 0) out.push(`JUROS DIARIO DE R$ ${fmtValor(jurosDia)}`);
  if (multaPct && multaPct > 0 && valor) {
    const valorMulta = (Number(multaPct) / 100) * Number(valor);
    out.push(`COBRAR MULTA DE ${fmtValor(valorMulta)} APOS ${fmtData(vencimento)}`);
  }
  (extras || []).forEach(e => e && out.push(String(e)));
  return out;
}

// ========== API publica ==========
async function gerarBoletoPdf(opts) {
  if (!opts || !opts.banco) throw new Error('Parametro banco obrigatorio.');
  if (!opts.linhaDigitavel) throw new Error('Parametro linhaDigitavel obrigatorio.');
  if (!opts.codigoBarras) throw new Error('Parametro codigoBarras obrigatorio (44 digitos).');

  // Pre-gera o codigo de barras (assincrono)
  const codigoBarrasPng = await gerarCodigoBarras(opts.codigoBarras);

  // Monta o documento
  const doc = new PDFDocument({ size: 'A4', margin: 30 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Render: recibo + corte + ficha
  doc.x = doc.page.margins.left;
  doc.y = doc.page.margins.top;

  const recOpts = { ...opts, codigoBarrasPng: null };
  const yMid = renderBloco(doc, recOpts, 'recibo');

  desenharCorte(doc, yMid + 8);
  doc.y = yMid + 16;
  doc.x = doc.page.margins.left;

  const ficOpts = { ...opts, codigoBarrasPng };
  renderBloco(doc, ficOpts, 'ficha');

  doc.end();
  return await done;
}

module.exports = { gerarBoletoPdf, BANCOS, montarInstrucoes };

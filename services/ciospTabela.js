// services/ciospTabela.js — planilha modelo da Tabela Comercial do CIOSP.
//
// O comercial preenche uma linha por linha da Tabela Comercial impressa e sobe na
// intranet. Aqui ficam o modelo para download e a leitura/validação. Nada é gravado
// neste arquivo: quem grava é services/ciospEdicao.js, e só quando não há erro.
//
// As colunas são achadas pelo TEXTO do cabeçalho (sem acento, minúsculo), não pela
// posição — quem mexer na ordem das colunas não quebra a importação.

const ExcelJS = require('exceljs');
const { paraCentavos } = require('./ciospPreco');

const COLUNAS = [
  'Seção', 'Grupo', 'TES', 'Código', 'Descrição', '13% 10x', '13% 6x', '11% 10x', '11% 6x',
  'Promoção (texto)', 'Promoção (%)', 'Promoção condicional (S/N)', 'Prazo de fabricação (dias)'
];

const normalizar = (s) => String(s == null ? '' : s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

// cabeçalho normalizado → campo
const CAMPO = {
  'secao': 'secao', 'grupo': 'grupo', 'tes': 'tes', 'codigo': 'codigo', 'descricao': 'descricao',
  '13% 10x': 'preco_13_10x', '13% 6x': 'preco_13_6x', '11% 10x': 'preco_11_10x', '11% 6x': 'preco_11_6x',
  'promocao (texto)': 'promocao_texto', 'promocao (%)': 'promocao_pct',
  'promocao condicional (s/n)': 'promocao_condicional', 'prazo de fabricacao (dias)': 'prazo_fabric'
};
const ROTULO = Object.fromEntries(COLUNAS.map(c => [CAMPO[normalizar(c)], c]));
const PRECOS = ['preco_13_10x', 'preco_13_6x', 'preco_11_10x', 'preco_11_6x'];
const OBRIGATORIAS = ['descricao', ...PRECOS];
const LIMITE = { secao: 60, grupo: 120, tes: 20, codigo: 60, promocao_texto: 300 };

// Valor "simples" de uma célula do exceljs (texto rico, fórmula, hiperlink…).
function valorCelula(v) {
  if (v == null) return null;
  if (typeof v === 'object' && !(v instanceof Date)) {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if ('result' in v) return valorCelula(v.result);
    if ('text' in v) return v.text;
    return null;
  }
  return v;
}
const texto = (v) => { const s = valorCelula(v); return s == null ? '' : String(s).trim(); };

function lerPercentual(v) {
  const s = texto(v).replace('%', '').trim();
  if (!s) return null;
  const c = paraCentavos(s);   // reaproveita o parser BR/US: "12,5" → 1250
  return Number.isNaN(c) ? NaN : c / 100;
}

async function lerPlanilha(buffer) {
  const erros = [];
  const avisos = [];
  const linhas = [];

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (e) {
    return { linhas, erros: [{ linha: 0, msg: 'Arquivo não é uma planilha .xlsx válida.' }], avisos };
  }
  const ws = wb.getWorksheet('Tabela') || wb.worksheets[0];
  if (!ws) return { linhas, erros: [{ linha: 0, msg: 'Planilha sem abas.' }], avisos };

  // Cabeçalho: a primeira das 10 primeiras linhas que tenha "Descrição".
  let linhaCab = 0;
  const colDe = {};
  for (let r = 1; r <= Math.min(10, ws.rowCount) && !linhaCab; r++) {
    const row = ws.getRow(r);
    const achadas = {};
    row.eachCell((cell, col) => {
      const campo = CAMPO[normalizar(texto(cell.value))];
      if (campo && !(campo in achadas)) achadas[campo] = col;
    });
    if ('descricao' in achadas) { linhaCab = r; Object.assign(colDe, achadas); }
  }
  const faltam = OBRIGATORIAS.filter(c => !(c in colDe));
  if (!linhaCab || faltam.length) {
    const nomes = (linhaCab ? faltam : OBRIGATORIAS).map(c => ROTULO[c]);
    return { linhas, erros: [{ linha: linhaCab || 1, msg: `Coluna obrigatória ausente: ${nomes.join(', ')}.` }], avisos };
  }

  for (let r = linhaCab + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const bruto = {};
    const formato = {};
    for (const [campo, col] of Object.entries(colDe)) {
      const cell = row.getCell(col);
      bruto[campo] = cell.value;
      formato[campo] = cell.numFmt || '';
    }
    if (Object.values(bruto).every(v => texto(v) === '')) continue;   // linha vazia

    const errosAntes = erros.length;
    const erro = (msg) => erros.push({ linha: r, msg });
    const opc = (campo) => {
      const s = texto(bruto[campo]);
      if (!s) return null;
      if (LIMITE[campo] && s.length > LIMITE[campo]) erro(`${ROTULO[campo]} passa de ${LIMITE[campo]} caracteres.`);
      return s;
    };

    const l = {
      ordem: r,
      secao: opc('secao'), grupo: opc('grupo'), tes: opc('tes'), codigo: opc('codigo'),
      descricao: texto(bruto.descricao)
    };
    if (!l.descricao) erro('Descrição vazia.');

    for (const p of PRECOS) {
      const v = valorCelula(bruto[p]);
      const c = paraCentavos(typeof v === 'number' ? v : texto(v));
      if (Number.isNaN(c)) { erro(`Preço ausente ou inválido em ${ROTULO[p]}.`); l[p] = null; }
      else if (c <= 0) { erro(`${ROTULO[p]} deve ser maior que zero.`); l[p] = null; }
      else l[p] = c / 100;
    }

    l.promocao_texto = opc('promocao_texto');
    let pct = lerPercentual(bruto.promocao_pct);
    // "10%" digitado no Excel vira o número 0,1 com formato de porcentagem.
    if (pct !== null && !Number.isNaN(pct) && typeof valorCelula(bruto.promocao_pct) === 'number'
        && formato.promocao_pct.includes('%')) {
      pct = Math.round(pct * 10000) / 100;
    }
    if (pct !== null && (Number.isNaN(pct) || pct < 0 || pct > 100)) {
      erro('Promoção (%) deve estar entre 0 e 100.');
      l.promocao_pct = null;
    } else {
      l.promocao_pct = pct;
    }
    l.promocao_condicional = ['s', 'sim', 'x', 'true', '1'].includes(normalizar(texto(bruto.promocao_condicional)));

    const prazo = texto(bruto.prazo_fabric);
    if (!prazo) l.prazo_fabric = null;
    else if (/^\d+$/.test(prazo)) l.prazo_fabric = Number(prazo);
    else { erro('Prazo de fabricação deve ser um número inteiro de dias.'); l.prazo_fabric = null; }

    if (erros.length > errosAntes) continue;

    if (l.preco_13_6x > l.preco_13_10x || l.preco_11_6x > l.preco_11_10x) {
      avisos.push({ linha: r, msg: 'Preço 6x maior que o preço 10x da mesma tabela.' });
    }
    if (l.preco_11_10x > l.preco_13_10x || l.preco_11_6x > l.preco_13_6x) {
      avisos.push({ linha: r, msg: 'Tabela 11% mais cara que a tabela 13%.' });
    }
    if (l.promocao_pct > 0 && l.promocao_pct < 1) {
      avisos.push({ linha: r, msg: `Promoção (%) = ${l.promocao_pct}: menos de 1% de desconto. Se a intenção era ${Math.round(l.promocao_pct * 100)}%, digite ${Math.round(l.promocao_pct * 100)}.` });
    }
    linhas.push(l);
  }

  return { linhas, erros, avisos };
}

async function gerarModelo() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tabela');
  ws.addRow(COLUNAS);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.columns = COLUNAS.map((c, i) => ({ width: i === 4 ? 60 : Math.max(12, c.length + 2) }));
  ws.addRow(['PEÇAS DE MÃO', 'ALTA ROTAÇÃO - ENCAIXE BORDEN', '530', '1169', 'ALTA ROTAÇÃO AX1 LED',
    1417.63, 1346.75, 1346.75, 1292.88, '10% DE DESCONTO ADICIONAL', 10, 'N', 15]);
  ws.addRow(['CONSULTÓRIOS GNATUS G1', 'G1 FIT SF', '531', '',
    'CONS GNATUS G1 FIT SF - CAIXA COMANDO INTEGRADA - ESTRUTURA COR BRANCA - ENC CABEÇA COM REG. ALTURA - ' +
    'BRAÇOS STANDARD - PEDAL 7 TECLAS - ESTOF CAD SOFT COM KIT PROTETOR DOS PÉS. UNIDADE DE ÁGUA REBATIVEL 90° - ' +
    '1 SUGADOR VENTURI. EQUIPO COM TRAVA MECÂNICA. 009444 - REFLETOR ODONTOLÓGICO HELIOS LED FSA. MOCHO STANDARD FIT.',
    25732.45, 24445.82, 24445.82, 23467.99, 'GANHE KIT BV', null, 'N', 45]);
  ws.getColumn(5).alignment = { wrapText: true, vertical: 'top' };

  const ins = wb.addWorksheet('Instruções');
  ins.getColumn(1).width = 110;
  [
    'Tabela Comercial do CIOSP — como preencher',
    '',
    '• Uma linha da aba "Tabela" para cada linha da Tabela Comercial impressa, na mesma ordem.',
    '• O mesmo produto pode aparecer em várias seções com preços diferentes (ex.: avulso e como upgrade): repita a linha.',
    '• Obrigatórios: Descrição e os 4 preços (13% 10x, 13% 6x, 11% 10x, 11% 6x). Preço pode ser número ou "R$ 1.234,56".',
    '• "13%" e "11%" são as tabelas de comissão do vendedor. "10x" = 10x no cartão ou 10% no Pix; "6x" = 6x no cartão ou 6% no Pix.',
    '• Código: como impresso ("1116", "5472 + 1134", "CONF COR" ou vazio).',
    '• Promoção (%): só o número do desconto adicional (ex.: 10). Brindes ("Ganhe kit BV") ficam só no texto.',
    '• Promoção condicional: S quando o desconto depende de algo ("na compra do kit multimídia"). O ADM confere.',
    '• Prazo de fabricação: dias, entra no prazo de entrega do contrato.',
    '• Importar de novo substitui a tabela inteira da edição. Orçamentos já feitos não mudam.'
  ].forEach((t, i) => { ins.addRow([t]); if (i === 0) ins.getRow(1).font = { bold: true, size: 13 }; });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { COLUNAS, lerPlanilha, gerarModelo };

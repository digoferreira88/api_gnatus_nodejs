// Parser dos arquivos da Omni (validado contra os arquivos reais, 05/10/2026). Dois formatos:
//  - CARTEIRA: .xlsx do portal Omni. Abas por faixa de atraso ("1 a 30 DIAS", "31 a 60 DIAS",
//    "61 a 90 DIAS") + aba "RESUMO" (ignorada). ⚠️ CABEÇALHO NA LINHA 2 (linha 1 é banner);
//    cada aba tem 1 linha de TOTAL no fim (descartada: contrato < 11 díg.).
//  - RECOMPRA: .xls que é HTML (Latin-1). Relatório por período ("Data Inicial:"/"Data Final:").
//    ⚠️ o cabeçalho tem 11 rótulos p/ 12 colunas de dados (falta "Vlr. Líquido") -> mapa por POSIÇÃO.
const ExcelJS = require('exceljs');

const txt = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    if (v.text) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    return '';
  }
  return String(v);
};
const soDig = (v) => txt(v).replace(/\D/g, '');
const norm = (s) => txt(s).trim().toLowerCase().replace(/\s+/g, ' ');
const num = (v) => {
  if (typeof v === 'number') return v;
  let s = txt(v).trim();
  if (!s) return null;
  s = s.replace(/[^\d,.-]/g, '');
  if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.'); // BR "143.665,55" -> 143665.55
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
};
const intOrNull = (v) => { const n = num(v); return n === null ? null : Math.trunc(n); };
const dataBR = (v) => { // dd/mm/yyyy -> yyyy-mm-dd
  const s = txt(v).trim();
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
};

// ---------- CARTEIRA (xlsx do portal) ----------
const MAP_CARTEIRA = {
  'contrato': 'contrato', 'cliente': 'cliente', 'cidade/uf': 'cidade_uf', 'produto': 'produto',
  'parcela': 'parcela', 'atraso': 'atraso_dias', 'faixa de atraso': 'faixa',
  'valor atrasado - data carteira': 'valor_atrasado', 'valor recebido no mês': 'valor_recebido_mes',
  '% recebido no mês': 'pct_recebido', 'dias sem acionamento': 'dias_sem_acionamento',
  'situação': 'situacao_portal', 'score': 'score', 'pdd fechamento': 'pdd_fechamento',
  'telefone': 'telefone', 'cpf': 'cpf'
};

async function parseCarteira(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const linhas = [];
  for (const ws of wb.worksheets) {
    const nome = norm(ws.name);
    if (nome.includes('resumo') || !ws.rowCount || ws.rowCount < 3) continue;
    const header = {};
    ws.getRow(2).eachCell({ includeEmpty: false }, (cell, col) => {
      const campo = MAP_CARTEIRA[norm(cell.value)];
      if (campo) header[col] = campo;
    });
    if (!Object.values(header).includes('contrato')) continue; // aba não é de carteira
    const faixaNome = txt(ws.name).replace(/\s*dias\s*$/i, '').trim(); // "1 a 30 DIAS" -> "1 a 30"
    for (let r = 3; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const o = {};
      Object.entries(header).forEach(([col, campo]) => {
        const raw = row.getCell(Number(col)).value;
        if (campo === 'contrato') o.contrato = soDig(raw);
        else if (campo === 'cpf') o.cpf = soDig(raw);
        else if (campo === 'faixa') { /* usamos o nome da aba */ }
        else if (['valor_atrasado', 'valor_recebido_mes', 'pct_recebido', 'pdd_fechamento'].includes(campo)) o[campo] = num(raw);
        else if (['atraso_dias', 'dias_sem_acionamento'].includes(campo)) o[campo] = intOrNull(raw);
        else o[campo] = txt(raw).trim();
      });
      if (!o.contrato || o.contrato.length < 11) continue; // descarta linha de total/subtotal
      o.faixa = faixaNome;
      linhas.push(o);
    }
  }
  return { tipo: 'CARTEIRA', periodo_ini: null, periodo_fim: null, linhas };
}

// ---------- RECOMPRA (.xls = HTML, Latin-1) ----------
function parseRecompra(buffer) {
  const html = Buffer.from(buffer).toString('latin1');
  const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi; let m;
  while ((m = trRe.exec(html)) !== null) {
    const cells = []; const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi; let c;
    while ((c = cellRe.exec(m[1])) !== null) cells.push(strip(c[1]));
    rows.push(cells);
  }
  let periodo_ini = null, periodo_fim = null;
  for (const r of rows) {
    const t = r[0] || '';
    if (/data inicial/i.test(t)) periodo_ini = dataBR(t);
    if (/data final/i.test(t)) periodo_fim = dataBR(t);
  }
  // colunas por POSIÇÃO (0..11): Agente, loja, Emissao, Proposta, Contrato, CPF, Cliente,
  // VlrFinanciado, VlrLiquido, DataRecompra, Atraso, ValorRecompra
  const linhas = [];
  for (const r of rows) {
    if (r.length !== 12) continue;
    const contrato = soDig(r[4]);
    if (!contrato || /contrato/i.test(r[4])) continue; // pula cabeçalho (texto "Contrato")
    linhas.push({
      contrato, cpf: soDig(r[5]), cliente: r[6],
      emissao: dataBR(r[2]), proposta: txt(r[3]).trim(),
      vlr_financiado: num(r[7]), vlr_liquido: num(r[8]),
      data_recompra: dataBR(r[9]), atraso_dias: intOrNull(r[10]), valor_recompra: num(r[11])
    });
  }
  return { tipo: 'RECOMPRA', periodo_ini, periodo_fim, linhas };
}

// Detecta o tipo pelo conteúdo/nome e despacha.
async function parseArquivo(buffer, nome) {
  const head = Buffer.from(buffer.slice(0, 64)).toString('latin1').toLowerCase();
  const ehHtml = head.includes('<table') || head.includes('<html') || head.includes('<tr');
  if (ehHtml || /recompr/i.test(nome || '')) return parseRecompra(buffer);
  return parseCarteira(buffer);
}

module.exports = { parseArquivo, parseCarteira, parseRecompra };

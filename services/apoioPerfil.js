// services/apoioPerfil.js
// Le um buffer XLSX/CSV e gera um "perfil" estatistico compacto para mandar
// pra IA decidir titulos/KPIs/graficos. Mantem o payload pequeno (so amostras
// + agregados) — nunca manda a planilha inteira pra IA.

const ExcelJS = require('exceljs');

const trim = (v) => String(v == null ? '' : v).trim();

const detectarTipo = (vals) => {
  const naoVazios = vals.filter(v => v != null && v !== '');
  if (naoVazios.length === 0) return 'vazio';
  let nNumeros = 0, nDatas = 0;
  for (const v of naoVazios) {
    if (v instanceof Date) { nDatas++; continue; }
    if (typeof v === 'number') { nNumeros++; continue; }
    const s = String(v);
    // Numero (com virgula, R$, %)
    if (/^-?\s*R?\$?\s*[\d.,]+\s*%?$/.test(s) && /\d/.test(s)) {
      const limpo = s.replace(/[R$\s%]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
      if (!isNaN(Number(limpo))) { nNumeros++; continue; }
    }
    // Data (YYYY-MM-DD ou DD/MM/YYYY)
    if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{2}\/\d{2}\/\d{4}/.test(s)) { nDatas++; continue; }
  }
  const total = naoVazios.length;
  if (nDatas / total > 0.8) return 'data';
  if (nNumeros / total > 0.8) return 'numero';
  return 'texto';
};

const parseNumero = (v) => {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return null;
  if (v == null) return null;
  const s = String(v).replace(/[R$\s%]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const parseData = (v) => {
  if (v instanceof Date) return v;
  if (typeof v !== 'string') return null;
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00Z');
  m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return new Date(m[3] + '-' + m[2] + '-' + m[1] + 'T00:00:00Z');
  return null;
};

const cellText = (c) => {
  if (!c) return '';
  let v = c.value;
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.text) return v.text;
    if (v.result != null) return v.result;
    if (v.richText) return v.richText.map(r => r.text).join('');
  }
  return v;
};

// Perfila uma aba: header + tipos de coluna + agregados + amostras
function perfilarAba (ws, nomeAba) {
  if (ws.rowCount < 2) return null;

  // Detecta linha de header — primeira linha com pelo menos 2 celulas nao-vazias
  let headerRow = 1;
  for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
    const row = ws.getRow(r);
    let preenchidas = 0;
    row.eachCell({ includeEmpty: false }, () => preenchidas++);
    if (preenchidas >= 2) { headerRow = r; break; }
  }

  const headerRowObj = ws.getRow(headerRow);
  const headers = [];
  headerRowObj.eachCell({ includeEmpty: true }, (c, n) => {
    headers[n - 1] = trim(cellText(c)) || `col_${n}`;
  });
  const numCols = headers.length;
  if (numCols === 0) return null;

  // Coleta valores por coluna (limita a 10k linhas pra nao explodir memoria)
  const maxLinhas = Math.min(ws.rowCount, headerRow + 10000);
  const valoresPorCol = headers.map(() => []);
  let totalDados = 0;
  for (let r = headerRow + 1; r <= maxLinhas; r++) {
    const row = ws.getRow(r);
    let temAlgo = false;
    for (let c = 0; c < numCols; c++) {
      const v = cellText(row.getCell(c + 1));
      valoresPorCol[c].push(v === '' ? null : v);
      if (v !== '' && v != null) temAlgo = true;
    }
    if (temAlgo) totalDados++;
  }

  // Amostra: 3 primeiras linhas reais (apos header)
  const amostra = [];
  for (let r = headerRow + 1; r <= Math.min(headerRow + 3, ws.rowCount); r++) {
    const obj = {};
    const row = ws.getRow(r);
    for (let c = 0; c < numCols; c++) {
      const v = cellText(row.getCell(c + 1));
      obj[headers[c]] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
    }
    amostra.push(obj);
  }

  // Linhas completas para o frontend agregar/plotar (max 5000 linhas).
  // Nao manda pra IA (alem do que ja esta nas amostras).
  const rows = [];
  const maxRowsExport = Math.min(ws.rowCount, headerRow + 5000);
  for (let r = headerRow + 1; r <= maxRowsExport; r++) {
    const row = ws.getRow(r);
    const obj = {};
    let temAlgo = false;
    for (let c = 0; c < numCols; c++) {
      const v = cellText(row.getCell(c + 1));
      if (v !== '' && v != null) temAlgo = true;
      obj[headers[c]] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
    }
    if (temAlgo) rows.push(obj);
  }

  const colunas = headers.map((nome, i) => {
    const vals = valoresPorCol[i];
    const tipo = detectarTipo(vals);
    const naoVazios = vals.filter(v => v != null && v !== '');

    if (tipo === 'numero') {
      const nums = naoVazios.map(parseNumero).filter(n => n != null);
      if (!nums.length) return { nome, tipo, total: vals.length, vazios: vals.length };
      const soma = nums.reduce((a, b) => a + b, 0);
      return {
        nome, tipo,
        total: vals.length, vazios: vals.length - nums.length,
        min: Math.min(...nums), max: Math.max(...nums),
        media: soma / nums.length, soma,
        distintos: new Set(nums).size
      };
    }

    if (tipo === 'data') {
      const datas = naoVazios.map(parseData).filter(d => d).map(d => d.getTime());
      if (!datas.length) return { nome, tipo, total: vals.length };
      return {
        nome, tipo,
        total: vals.length,
        min: new Date(Math.min(...datas)).toISOString().slice(0, 10),
        max: new Date(Math.max(...datas)).toISOString().slice(0, 10),
        distintos: new Set(datas).size
      };
    }

    // Texto / categoria
    const contagem = new Map();
    for (const v of naoVazios) {
      const k = String(v instanceof Date ? v.toISOString().slice(0, 10) : v);
      contagem.set(k, (contagem.get(k) || 0) + 1);
    }
    const top = [...contagem.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([valor, qt]) => ({ valor, qt }));
    return {
      nome, tipo: contagem.size <= 50 ? 'categoria' : 'texto',
      total: vals.length, vazios: vals.length - naoVazios.length,
      distintos: contagem.size,
      top
    };
  });

  return { nome: nomeAba, linhas: totalDados, colunas, amostra, rows };
}

async function perfilarBuffer (buffer, nomeArquivo) {
  const ext = (nomeArquivo || '').toLowerCase().split('.').pop();
  const wb = new ExcelJS.Workbook();

  if (ext === 'csv') {
    // exceljs aceita CSV via API separada, mas ela exige stream — pra simplificar
    // convertemos CSV em string + parseamos manualmente (CSV simples, virgula/ponto-virgula)
    const conteudo = buffer.toString('utf8');
    const sep = conteudo.split('\n')[0].includes(';') ? ';' : ',';
    const linhas = conteudo.split(/\r?\n/).filter(l => l.length);
    const ws = wb.addWorksheet('Dados');
    linhas.forEach((linha, i) => {
      const cells = linha.split(sep).map(c => c.replace(/^"|"$/g, ''));
      ws.getRow(i + 1).values = [null, ...cells];   // exceljs e 1-indexado
    });
  } else {
    await wb.xlsx.load(buffer);
  }

  const abas = [];
  wb.eachSheet((ws) => {
    const p = perfilarAba(ws, ws.name);
    if (p) abas.push(p);
  });

  return {
    arquivo: nomeArquivo,
    extensao: ext,
    abas,
    totais: {
      abas: abas.length,
      linhas: abas.reduce((acc, a) => acc + a.linhas, 0),
      colunas: abas.reduce((acc, a) => acc + a.colunas.length, 0)
    }
  };
}

module.exports = { perfilarBuffer };

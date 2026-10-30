// services/qfImport.js — importação das planilhas atuais para o módulo.
//
//   lista      FORM 7.3.24 (Lista de Fornecedores Qualificados) → tab_qf_fornecedor
//   inspecoes  FORM 7.4.3.H (aba "FORM 7.4.3.H") ou a aba oculta "BANCO DE DADOS"
//              da 7.3.24 → tab_qf_inspecao
//
// Princípios:
//  - O histórico entra COMO ESTÁ: C, P, N e IQF gravados pelos inspetores são
//    mantidos (não recalculados). A versão de regra apontada é a da planilha.
//  - Cada linha estranha vira um aviso na própria linha (legado_avisos) e no
//    relatório — nada é corrigido em silêncio.
//  - Reimportar é seguro: só insere o que falta e só atualiza o que veio da
//    planilha e ninguém editou no módulo depois (atualizado_por IS NULL).
//  - dryRun = lê, valida e devolve o relatório sem gravar.

const ExcelJS = require('exceljs');
const R = require('./qfRegras');
const Core = require('./qfCore');

const semAcento = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const chaveCab = (s) => semAcento(s).toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();

function valor(cell) {
  let v = cell ? cell.value : null;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) v = v.result;
    else if (v.richText) v = v.richText.map(t => t.text).join('');
    else if ('text' in v) v = v.text;
    else if ('error' in v) v = null;
    else if ('formula' in v || 'sharedFormula' in v) v = null;   // fórmula sem valor calculado gravado
  }
  if (v && typeof v === 'object' && !(v instanceof Date) && 'error' in v) v = null;
  return v;
}
const texto = (v) => (v == null ? null : (String(v).trim() || null));
const numero = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/\./g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

// Data da planilha: Date, nº serial do Excel ou texto dd/mm/aa(aa).
function dataISO(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10);
  const m = String(v).trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const ano = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(Date.UTC(ano, Number(m[2]) - 1, Number(m[1])));
    if (d.getUTCDate() === Number(m[1])) return d.toISOString().slice(0, 10);
  }
  return null;
}

function simNao(v) {
  const s = semAcento(v).trim().toUpperCase();
  if (!s) return null;
  if (['SIM', 'SM', 'S', 'YES'].includes(s)) return 'SIM';
  if (['NAO', 'N', 'NO'].includes(s)) return 'NAO';
  if (['N/A', 'NA', 'N.A.'].includes(s)) return 'NA';
  return undefined; // valor estranho → aviso
}

// "Não" → [] · "A" → [A] · "A e B" → [A, B]. Valor estranho → undefined (aviso).
function criticidade(v) {
  const s = semAcento(v).trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s || s === 'NAO' || s === 'N') return [];
  if (/^[ABCD](\s*(E|\/|\+|,)\s*[ABCD])*$/.test(s)) return R.normCriticidades(s);
  return undefined;
}

function tipoFornecimento(v) {
  const s = semAcento(v).trim().toUpperCase();
  if (!s || s === 'N/A' || s === 'NA') return null;
  if (s === 'MP') return 'MP';
  if (s.startsWith('SERV')) return 'SERVICO';
  if (s.includes('MP') && s.includes('SERV')) return 'MP_SERVICO';
  return undefined;
}

function nivel(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (!s) return null;
  if (s === 'I' || s === '1') return 'I';
  if (s === 'II' || s === '2') return 'II';
  if (s === 'III' || s === '3') return 'III';
  if (s.startsWith('100')) return '100';
  return undefined;
}

async function abrir(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

// Acha a linha de cabeçalho cuja célula contém `rotulo` e devolve o mapa nome→coluna.
function acharCabecalho(ws, rotulo, maxLinhas = 15) {
  const alvo = chaveCab(rotulo);
  for (let r = 1; r <= Math.min(maxLinhas, ws.rowCount); r++) {
    const row = ws.getRow(r);
    let achou = false;
    const mapa = {};
    row.eachCell({ includeEmpty: false }, (c, col) => {
      const k = chaveCab(valor(c));
      if (!k) return;
      if (k === alvo) achou = true;
      if (!(k in mapa)) mapa[k] = col;
    });
    if (achou) return { linha: r, mapa };
  }
  return null;
}

// ---------------------------------------------------------------- leitura: FORM 7.3.24
function lerLista(wb) {
  const ws = wb.worksheets.find(w => /7\.3\.24/.test(w.name) && w.state !== 'hidden') || wb.getWorksheet('FORM 7.3.24');
  if (!ws) throw new Error('Aba "FORM 7.3.24" não encontrada — este arquivo não é a Lista de Fornecedores Qualificados.');
  const cab = acharCabecalho(ws, 'CÓDIGO');
  if (!cab) throw new Error('Cabeçalho "CÓDIGO" não encontrado na aba FORM 7.3.24.');
  // a 7.3.24 tem duas linhas de cabeçalho (agrupador + nomes); os dados começam depois de "BPF"
  let inicio = cab.linha + 1;
  const prox = ws.getRow(inicio);
  if (chaveCab(valor(prox.getCell(2))) === 'codigo') inicio++;

  const col = { codigo: 2, nome: 3, crit: 4, tipo: 5, bpf: 6, iso13485: 7, iso9001: 8, acordo: 9, quest: 10, nota: 11 };
  const linhas = [];
  for (let r = inicio; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cod = texto(valor(row.getCell(col.codigo)));
    if (!cod) continue;
    linhas.push({
      linha: r, codigoBruto: cod, codigo: R.normalizarCodigo(cod), nome: texto(valor(row.getCell(col.nome))),
      crit: valor(row.getCell(col.crit)), tipo: valor(row.getCell(col.tipo)),
      bpf: valor(row.getCell(col.bpf)), iso13485: valor(row.getCell(col.iso13485)), iso9001: valor(row.getCell(col.iso9001)),
      acordo: valor(row.getCell(col.acordo)), quest: valor(row.getCell(col.quest)), nota: valor(row.getCell(col.nota))
    });
  }
  return linhas;
}

function montarFornecedorDaLista(l) {
  const avisos = [];
  let crit = criticidade(l.crit);
  if (crit === undefined) { avisos.push(`criticidade "${l.crit}" não reconhecida — gravado como não crítico`); crit = []; }
  let tipo = tipoFornecimento(l.tipo);
  if (tipo === undefined) { avisos.push(`tipo "${l.tipo}" não reconhecido`); tipo = null; }
  const sgq = {};
  for (const k of ['bpf', 'iso13485', 'iso9001', 'acordo']) {
    const v = simNao(l[k]);
    if (v === undefined) { avisos.push(`${k.toUpperCase()}: valor "${l[k]}" na planilha`); sgq[k] = null; } else sgq[k] = v;
  }
  let nota = numero(l.nota);
  let quest = simNao(l.quest);
  if (quest === undefined) {
    const n = numero(l.quest);
    if (n != null && nota == null) { nota = n; quest = 'SIM'; avisos.push(`nota ${n} estava na coluna QUEST (movida para NOTA)`); }
    else { avisos.push(`QUEST: valor "${l.quest}" na planilha`); quest = null; }
  }
  // status: não crítico não exige qualificação prévia (PRO 7.3.7 item 5.2)
  let status = 'APROVADO';
  if (crit.length) {
    if (nota == null) avisos.push('crítico sem nota do questionário na planilha — regularizar');
    else if (nota < 50) { status = 'APROVADO_COM_RESTRICAO'; avisos.push(`nota ${nota} abaixo de 50: pelo PRO 7.3.7 seria REPROVADO — revisar`); }
    else if (nota < 70) status = 'APROVADO_COM_RESTRICAO';
    avisos.push('documentos regulatórios não migrados (legado — regularizar)');
    avisos.push('sem data de qualificação na planilha — programar a requalificação anual (PRO 5.10)');
  }
  return {
    codigo: l.codigo, razao_social: (l.nome || `Fornecedor ${l.codigo}`).slice(0, 200), criticidades: crit, tipo_fornecimento: tipo,
    status_qualificacao: status,
    sgq_bpf: sgq.bpf, sgq_iso13485: sgq.iso13485, sgq_iso9001: sgq.iso9001, sgq_acordo: sgq.acordo, sgq_questionario: quest,
    nota_sgq: nota, pendencias: avisos.length ? avisos : null
  };
}

// ---------------------------------------------------------------- leitura: FORM 7.4.3.H
const CAMPOS_INSP = {
  rel: 'rel insp', cod: 'cod fornec', nome: 'fornecedor', pc: 'pedido compras', item: 'cod do item', nf: 'nota fiscal',
  lote: 'lote', nivel: 'nivel insp', qr: 'qtd rec', qi: 'qtd insp', esp: 'esp', crit: 'criterio de aceitacao',
  res: 'resultado', instr: 'instrumento utilizado', qa: 'quant aprov', qrep: 'quant repro', rnc: 'rnc n', data: 'data',
  c: 'c', p: 'p', n: 'n', iqf: 'iqf', resp: 'responsavel pela inspecao'
};

function lerInspecoes(wb) {
  const ws = wb.getWorksheet('FORM 7.4.3.H') || wb.getWorksheet('BANCO DE DADOS');
  if (!ws) throw new Error('Aba "FORM 7.4.3.H" (ou "BANCO DE DADOS") não encontrada — este arquivo não é o Relatório de Inspeção de Recebimento.');
  const cab = acharCabecalho(ws, 'Rel. Insp.');
  if (!cab) throw new Error('Cabeçalho "Rel. Insp." não encontrado.');
  const col = {};
  for (const [k, rot] of Object.entries(CAMPOS_INSP)) {
    const achado = Object.entries(cab.mapa).find(([h]) => h === rot || h.startsWith(rot + ' '));
    col[k] = achado ? achado[1] : null;
  }
  const faltando = ['rel', 'cod', 'qi', 'qa', 'data', 'c', 'p', 'n'].filter(k => !col[k]);
  if (faltando.length) throw new Error(`Colunas não encontradas na planilha de inspeção: ${faltando.join(', ')}.`);

  // nomes dos fornecedores (aba de apoio da 7.4.3.H)
  const nomes = new Map();
  const wl = wb.getWorksheet('LISTA DE FORNECEDORES') || wb.getWorksheet('FORNECEDORES');
  if (wl) wl.eachRow((row) => {
    const c = texto(valor(row.getCell(1))), n = texto(valor(row.getCell(2)));
    if (c && n && /^\d{1,6}$/.test(c)) nomes.set(R.normalizarCodigo(c), n);
  });

  const g = (row, k) => (col[k] ? valor(row.getCell(col[k])) : null);
  const linhas = [];
  for (let r = cab.linha + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rel = numero(g(row, 'rel'));
    const cod = texto(g(row, 'cod'));
    if (rel == null || !cod) continue;   // linhas pré-numeradas, ainda vazias
    linhas.push({
      linha: r, rel: Math.trunc(rel), codBruto: cod, nome: texto(g(row, 'nome')),
      pc: texto(g(row, 'pc')), item: texto(g(row, 'item')), nf: texto(g(row, 'nf')), lote: texto(g(row, 'lote')),
      nivel: g(row, 'nivel'), qr: g(row, 'qr'), qi: g(row, 'qi'), esp: texto(g(row, 'esp')), crit: texto(g(row, 'crit')),
      res: texto(g(row, 'res')), instr: texto(g(row, 'instr')), qa: g(row, 'qa'), qrep: g(row, 'qrep'), rnc: texto(g(row, 'rnc')),
      data: g(row, 'data'), c: g(row, 'c'), p: g(row, 'p'), n: g(row, 'n'), iqf: g(row, 'iqf'), resp: texto(g(row, 'resp'))
    });
  }
  return { linhas, nomes, aba: ws.name };
}

function montarInspecao(l, hoje) {
  const avisos = [];
  const codigo = R.normalizarCodigo(l.codBruto);
  if (!/^\d{6}$/.test(codigo)) return { erro: `código de fornecedor "${l.codBruto}" inválido` };
  if (codigo !== l.codBruto) avisos.push(`código "${l.codBruto}" completado para ${codigo}`);
  let nv = nivel(l.nivel);
  if (nv === undefined) { avisos.push(`nível "${l.nivel}" não reconhecido`); nv = null; }
  const qr = numero(l.qr), qi = numero(l.qi), qa = numero(l.qa), qrep = numero(l.qrep) ?? 0;
  if (l.qi != null && l.qi !== '' && qi == null) avisos.push(`qtd. inspecionada "${l.qi}" não numérica`);
  else if (qi == null) avisos.push(qr != null && qr < 2
    ? `qtd. inspecionada vazia (lote de ${qr} peça — fora da tabela de amostragem)`
    : 'qtd. inspecionada vazia');
  if (qa == null) avisos.push('qtd. aprovada vazia');
  if (qi != null && qa != null && Math.abs(qa + qrep - qi) > 1e-6) avisos.push(`aprovada (${qa}) + reprovada (${qrep}) ≠ inspecionada (${qi})`);
  if (qi != null && qr != null && qi - qr > 1e-6) avisos.push(`inspecionada (${qi}) maior que a recebida (${qr})`);
  const data = dataISO(l.data);
  if (!data) avisos.push(l.data == null ? 'sem data' : `data "${l.data}" não reconhecida`);
  else if (data > hoje) avisos.push(`data ${data} no futuro (provável erro de digitação)`);
  const c = numero(l.c), p = numero(l.p), n = numero(l.n);
  let iqf = numero(l.iqf);
  if (iqf == null && c != null && p != null && n != null) iqf = R.calcularIQF(c, p, n);
  if (iqf != null && c != null && p != null && n != null && Math.abs(c * p * n - iqf) > 0.01) avisos.push(`IQF ${iqf} ≠ C×P×N (${R.calcularIQF(c, p, n)})`);
  if (c == null || p == null || n == null) avisos.push('C/P/N incompletos');
  return {
    rel_insp: l.rel, fornecedor_codigo: codigo, fornecedor_nome: l.nome,
    pedido_compras: l.pc ? l.pc.slice(0, 20) : null, cod_item: l.item ? l.item.slice(0, 30) : null,
    nota_fiscal: l.nf ? l.nf.slice(0, 30) : null, lote: l.lote ? l.lote.slice(0, 60) : null,
    nivel_inspecao: nv, qtd_recebida: qr, qtd_inspecionada: qi, qtd_aprovada: qa, qtd_reprovada: qrep,
    especificacao: l.esp, criterio_aceitacao: l.crit, resultado_descricao: l.res,
    instrumento_utilizado: l.instr ? l.instr.slice(0, 200) : null, rnc_numero: l.rnc ? l.rnc.slice(0, 40) : null,
    data_inspecao: data, pct_conforme: qi ? Math.round(Math.min(qa ?? 0, qi) / qi * 100000) / 1000 : null,
    nc: R.ehNC({ qtdReprovada: qrep, rncNumero: l.rnc }),
    indice_c: c, indice_p: p, indice_n: n, iqf,
    responsavel_nome: l.resp ? l.resp.slice(0, 120) : null,
    legado_avisos: avisos.length ? avisos : null
  };
}

// ---------------------------------------------------------------- gravação
async function inserirLote(q, tabela, colunas, tipos, linhas, conflito) {
  for (let i = 0; i < linhas.length; i += 500) {
    const fatia = linhas.slice(i, i + 500);
    await q(`INSERT INTO ${tabela} (${colunas.join(', ')})
      SELECT ${colunas.join(', ')} FROM jsonb_to_recordset(@rows::jsonb) AS x(${colunas.map((c, k) => `${c} ${tipos[k]}`).join(', ')})
      ${conflito}`, { rows: JSON.stringify(fatia) });
  }
}

const COLS_FORN = ['codigo', 'razao_social', 'criticidades', 'tipo_fornecimento', 'status_qualificacao', 'sgq_bpf', 'sgq_iso13485', 'sgq_iso9001',
  'sgq_acordo', 'sgq_questionario', 'nota_sgq', 'pendencias', 'origem', 'legado', 'nacional', 'data_aprovacao'];
const TIPOS_FORN = ['text', 'text', 'varchar[]', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'numeric', 'text[]', 'text', 'boolean', 'boolean', 'timestamptz'];

async function importarLista(app, buffer, { dryRun = false, req = null } = {}) {
  const { Pg } = app.services;
  const wb = await abrir(buffer);
  const linhas = lerLista(wb);
  const porCodigo = new Map();
  const duplicados = [];
  for (const l of linhas) {
    const f = montarFornecedorDaLista(l);
    if (porCodigo.has(f.codigo)) {
      duplicados.push({ codigo: f.codigo, linha: l.linha });
      const atual = porCodigo.get(f.codigo);
      // fica a linha mais completa (crítico / com avaliação SGQ)
      const peso = (x) => (x.criticidades.length ? 10 : 0) + (x.nota_sgq != null ? 5 : 0) + (x.sgq_acordo ? 1 : 0);
      if (peso(f) > peso(atual)) porCodigo.set(f.codigo, f);
    } else porCodigo.set(f.codigo, f);
  }
  const fornecedores = [...porCodigo.values()].map(f => ({ ...f, origem: 'PLANILHA_7324', legado: true, nacional: true, data_aprovacao: null }));
  const resumo = {
    tipo: 'lista', linhasLidas: linhas.length, fornecedores: fornecedores.length,
    duplicados: duplicados.length, exemplosDuplicados: duplicados.slice(0, 15),
    porCriticidade: fornecedores.reduce((m, f) => { const k = f.criticidades.length ? f.criticidades.join('+') : 'NAO_CRITICO'; m[k] = (m[k] || 0) + 1; return m; }, {}),
    porStatus: fornecedores.reduce((m, f) => (m[f.status_qualificacao] = (m[f.status_qualificacao] || 0) + 1, m), {}),
    comAvisos: fornecedores.filter(f => f.pendencias).map(f => ({ codigo: f.codigo, nome: f.razao_social, criticidades: f.criticidades, avisos: f.pendencias }))
      .filter(x => x.criticidades.length || x.avisos.some(a => !a.startsWith('documentos')))
  };
  if (dryRun) return { ...resumo, gravado: false };

  const antes = await Pg.connectAndQuery(`SELECT COUNT(*)::int n FROM tab_qf_fornecedor`);
  await Core.tx(Pg, async (q) => {
    await inserirLote(q, 'tab_qf_fornecedor', COLS_FORN, TIPOS_FORN, fornecedores,
      `ON CONFLICT (codigo) DO UPDATE SET
         razao_social = EXCLUDED.razao_social, criticidades = EXCLUDED.criticidades, tipo_fornecimento = EXCLUDED.tipo_fornecimento,
         status_qualificacao = EXCLUDED.status_qualificacao, sgq_bpf = EXCLUDED.sgq_bpf, sgq_iso13485 = EXCLUDED.sgq_iso13485,
         sgq_iso9001 = EXCLUDED.sgq_iso9001, sgq_acordo = EXCLUDED.sgq_acordo, sgq_questionario = EXCLUDED.sgq_questionario,
         nota_sgq = EXCLUDED.nota_sgq, pendencias = EXCLUDED.pendencias, origem = EXCLUDED.origem, legado = TRUE, atualizado_em = NOW()
       WHERE tab_qf_fornecedor.legado AND tab_qf_fornecedor.atualizado_por IS NULL`);
    await Core.log(Pg, req, { entidade: 'importacao', acao: 'IMPORTAR_LISTA', mudancas: [{ campo: 'fornecedores', de: null, para: fornecedores.length }], motivo: 'FORM 7.3.24' }, q);
  });
  const depois = await Pg.connectAndQuery(`SELECT COUNT(*)::int n FROM tab_qf_fornecedor`);
  return { ...resumo, gravado: true, inseridos: depois[0].n - antes[0].n };
}

const COLS_INSP = ['rel_insp', 'fornecedor_id', 'fornecedor_codigo', 'fornecedor_nome', 'pedido_compras', 'cod_item', 'nota_fiscal', 'lote',
  'nivel_inspecao', 'qtd_recebida', 'qtd_inspecionada', 'qtd_aprovada', 'qtd_reprovada', 'especificacao', 'criterio_aceitacao',
  'resultado_descricao', 'instrumento_utilizado', 'rnc_numero', 'data_inspecao', 'pct_conforme', 'nc', 'indice_c', 'indice_p', 'indice_n',
  'iqf', 'regra_versao_id', 'responsavel_nome', 'origem', 'legado_avisos', 'criado_por'];
const TIPOS_INSP = ['int', 'int', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'numeric', 'numeric', 'numeric', 'numeric', 'text', 'text',
  'text', 'text', 'text', 'date', 'numeric', 'boolean', 'numeric', 'numeric', 'numeric', 'numeric', 'int', 'text', 'text', 'text[]', 'int'];

async function importarInspecoes(app, buffer, { dryRun = false, req = null } = {}) {
  const { Pg } = app.services;
  const hoje = new Date().toISOString().slice(0, 10);
  const wb = await abrir(buffer);
  const { linhas, nomes, aba } = lerInspecoes(wb);
  const ignoradas = [];
  const insp = [];
  const relVisto = new Set();
  for (const l of linhas) {
    const m = montarInspecao(l, hoje);
    if (m.erro) { ignoradas.push({ rel: l.rel, linha: l.linha, motivo: m.erro }); continue; }
    if (relVisto.has(m.rel_insp)) { ignoradas.push({ rel: l.rel, linha: l.linha, motivo: 'Rel. Insp. repetido na planilha' }); continue; }
    relVisto.add(m.rel_insp);
    insp.push(m);
  }

  // N < 1 sem NC nas 3 entregas anteriores do fornecedor: provável erro de preenchimento
  // (decisão 30/10). O valor gravado é mantido — só fica sinalizado para revisão.
  const porForn = new Map();
  for (const i of insp) { if (!porForn.has(i.fornecedor_codigo)) porForn.set(i.fornecedor_codigo, []); porForn.get(i.fornecedor_codigo).push(i); }
  for (const lista of porForn.values()) {
    lista.sort((a, b) => String(a.data_inspecao || '').localeCompare(String(b.data_inspecao || '')) || a.rel_insp - b.rel_insp);
    lista.forEach((i, k) => {
      if (i.indice_n == null || Number(i.indice_n) >= 1) return;
      if (!lista.slice(Math.max(0, k - 3), k).some(x => x.nc)) {
        i.legado_avisos = [...(i.legado_avisos || []), `N ${String(i.indice_n).replace('.', ',')} sem NC nas 3 entregas anteriores — provável erro de preenchimento`];
      }
    });
  }

  // conferência no formato da planilha: SOMASE/CONT.SE por código (linhas com IQF)
  const planilha = new Map();
  for (const i of insp) {
    if (i.iqf == null) continue;
    const p = planilha.get(i.fornecedor_codigo) || { soma: 0, qtd: 0 };
    p.soma += Number(i.iqf); p.qtd++;
    planilha.set(i.fornecedor_codigo, p);
  }
  const infitek = planilha.get('003794');
  const regraPlanilha = (await Pg.connectAndQuery(`SELECT id FROM tab_qf_regra_versao WHERE nome LIKE 'FORM 7.4.3.H%' ORDER BY id LIMIT 1`))[0];
  const regra = (await Core.regraAtiva(Pg)).conteudo;

  const avisosPorTipo = {};
  insp.forEach(i => (i.legado_avisos || []).forEach(a => { const k = a.replace(/\d[\d.,/-]*/g, '#').replace(/"[^"]*"/g, '"…"'); avisosPorTipo[k] = (avisosPorTipo[k] || 0) + 1; }));
  const datas = insp.map(i => i.data_inspecao).filter(Boolean).sort();
  const resumo = {
    tipo: 'inspecoes', aba, linhasComDados: linhas.length, inspecoes: insp.length, ignoradas,
    periodo: datas.length ? { de: datas[0], ate: datas[datas.length - 1] } : null,
    comAvisos: insp.filter(i => i.legado_avisos).length, avisosPorTipo,
    fornecedores: planilha.size,
    validacaoInfitek: infitek ? { qtd: infitek.qtd, iqfMedio: Math.round(infitek.soma / infitek.qtd * 10000) / 10000, classe: R.classificar(regra, infitek.soma / infitek.qtd)?.classe } : null
  };
  if (dryRun) return { ...resumo, gravado: false };

  const u = Core.usuario(req);
  let criados = 0;
  await Core.tx(Pg, async (q) => {
    // fornecedores citados nas inspeções que ainda não estão no módulo
    const codigos = [...new Set(insp.map(i => i.fornecedor_codigo))];
    const existentes = new Set((await q(`SELECT codigo FROM tab_qf_fornecedor WHERE codigo = ANY(@c)`, { c: codigos })).map(r => r.codigo));
    const novos = codigos.filter(c => !existentes.has(c)).map(c => {
      const nome = nomes.get(c) || insp.find(i => i.fornecedor_codigo === c && i.fornecedor_nome)?.fornecedor_nome || `Fornecedor ${c}`;
      return {
        codigo: c, razao_social: nome.slice(0, 200), criticidades: [], tipo_fornecimento: null, status_qualificacao: 'APROVADO',
        sgq_bpf: null, sgq_iso13485: null, sgq_iso9001: null, sgq_acordo: null, sgq_questionario: null, nota_sgq: null,
        pendencias: ['cadastrado pela importação das inspeções (não estava na FORM 7.3.24) — conferir os itens que fornece (criticidade)'],
        origem: 'PLANILHA_743H', legado: true, nacional: true, data_aprovacao: null
      };
    });
    if (novos.length) await inserirLote(q, 'tab_qf_fornecedor', COLS_FORN, TIPOS_FORN, novos, 'ON CONFLICT (codigo) DO NOTHING');
    criados = novos.length;

    const ids = new Map((await q(`SELECT id, codigo, razao_social FROM tab_qf_fornecedor WHERE codigo = ANY(@c)`, { c: codigos })).map(r => [r.codigo, r]));
    const linhasBanco = insp.map(i => ({
      ...i, fornecedor_id: ids.get(i.fornecedor_codigo).id,
      fornecedor_nome: (i.fornecedor_nome || ids.get(i.fornecedor_codigo).razao_social || '').slice(0, 200),
      regra_versao_id: regraPlanilha ? regraPlanilha.id : null, origem: 'PLANILHA', criado_por: u.id
    }));
    await inserirLote(q, 'tab_qf_inspecao', COLS_INSP, TIPOS_INSP, linhasBanco,
      `ON CONFLICT (rel_insp) DO UPDATE SET
         fornecedor_id = EXCLUDED.fornecedor_id, fornecedor_codigo = EXCLUDED.fornecedor_codigo, fornecedor_nome = EXCLUDED.fornecedor_nome,
         pedido_compras = EXCLUDED.pedido_compras, cod_item = EXCLUDED.cod_item, nota_fiscal = EXCLUDED.nota_fiscal, lote = EXCLUDED.lote,
         nivel_inspecao = EXCLUDED.nivel_inspecao, qtd_recebida = EXCLUDED.qtd_recebida, qtd_inspecionada = EXCLUDED.qtd_inspecionada,
         qtd_aprovada = EXCLUDED.qtd_aprovada, qtd_reprovada = EXCLUDED.qtd_reprovada, especificacao = EXCLUDED.especificacao,
         criterio_aceitacao = EXCLUDED.criterio_aceitacao, resultado_descricao = EXCLUDED.resultado_descricao,
         instrumento_utilizado = EXCLUDED.instrumento_utilizado, rnc_numero = EXCLUDED.rnc_numero, data_inspecao = EXCLUDED.data_inspecao,
         pct_conforme = EXCLUDED.pct_conforme, nc = EXCLUDED.nc, indice_c = EXCLUDED.indice_c, indice_p = EXCLUDED.indice_p,
         indice_n = EXCLUDED.indice_n, iqf = EXCLUDED.iqf, responsavel_nome = EXCLUDED.responsavel_nome, legado_avisos = EXCLUDED.legado_avisos,
         atualizado_em = NOW()
       WHERE tab_qf_inspecao.origem = 'PLANILHA' AND tab_qf_inspecao.atualizado_por IS NULL`);
    await Core.log(Pg, req, { entidade: 'importacao', acao: 'IMPORTAR_INSPECOES', mudancas: [{ campo: 'inspecoes', de: null, para: insp.length }, { campo: 'fornecedores_criados', de: null, para: criados }], motivo: `FORM 7.4.3.H (aba ${aba})` }, q);
  });

  // IQF materializado de todos os fornecedores com inspeção (sem disparar ações automáticas)
  await recalcularTodos(app, { regra });

  // conferência pós-gravação: banco × planilha
  const banco = await Pg.connectAndQuery(`SELECT codigo, iqf_medio, qtd_inspecoes, classificacao FROM tab_qf_fornecedor WHERE qtd_inspecoes > 0`);
  const divergentes = [];
  for (const b of banco) {
    const p = planilha.get(b.codigo);
    const mediaPlan = p ? Math.round(p.soma / p.qtd * 10000) / 10000 : null;
    if (!p || p.qtd !== b.qtd_inspecoes || Math.abs(mediaPlan - Number(b.iqf_medio)) > 0.0001) {
      divergentes.push({ codigo: b.codigo, planilha: p ? { qtd: p.qtd, media: mediaPlan } : null, banco: { qtd: b.qtd_inspecoes, media: Number(b.iqf_medio) } });
    }
  }
  const infBanco = banco.find(b => b.codigo === '003794');
  return {
    ...resumo, gravado: true, fornecedoresCriados: criados,
    conferencia: {
      fornecedoresComInspecao: banco.length, divergentes: divergentes.length, exemplos: divergentes.slice(0, 20),
      infitekNoBanco: infBanco ? { qtd: infBanco.qtd_inspecoes, iqfMedio: Number(infBanco.iqf_medio), classe: infBanco.classificacao } : null,
      infitekOk: !!infBanco && infBanco.qtd_inspecoes === 14 && Math.abs(Number(infBanco.iqf_medio) - 10.2857) < 0.0001 && infBanco.classificacao === 'A'
    }
  };
}

// Recalcula IQF/classe de todos os fornecedores (importação ou troca de regra).
// Só fornecedor CRÍTICO é classificado (decisão 30/10). Não dispara as ações por classe —
// só registra a mudança na trilha.
async function recalcularTodos(app, { regra = null, req = null } = {}) {
  const { Pg } = app.services;
  const rg = regra || (await Core.regraAtiva(Pg)).conteudo;
  const agg = await Pg.connectAndQuery(
    `SELECT f.id, f.classificacao antes, cardinality(f.criticidades) > 0 AS monitorado, AVG(i.iqf) media, COUNT(i.iqf)::int qtd, MAX(i.data_inspecao) ultima
       FROM tab_qf_fornecedor f
       LEFT JOIN tab_qf_inspecao i ON i.fornecedor_id = f.id AND NOT i.excluido AND i.iqf IS NOT NULL
      GROUP BY f.id, f.classificacao, f.criticidades`);
  const linhas = agg.map(a => {
    const media = a.qtd ? Core.r4(a.media) : null;
    return { id: a.id, antes: a.antes, iqf_medio: media, qtd_inspecoes: a.qtd, classificacao: a.monitorado ? (R.classificar(rg, media)?.classe || null) : null, ultima_inspecao: a.ultima };
  });
  for (let i = 0; i < linhas.length; i += 1000) {
    await Pg.connectAndQuery(
      `UPDATE tab_qf_fornecedor f SET iqf_medio = x.iqf_medio, qtd_inspecoes = x.qtd_inspecoes, classificacao = x.classificacao,
              ultima_inspecao = x.ultima_inspecao, iqf_atualizado_em = NOW()
         FROM jsonb_to_recordset(@rows::jsonb) AS x(id int, iqf_medio numeric, qtd_inspecoes int, classificacao text, ultima_inspecao date)
        WHERE f.id = x.id`, { rows: JSON.stringify(linhas.slice(i, i + 1000)) });
  }
  const mudaram = linhas.filter(l => (l.antes || null) !== l.classificacao);
  if (mudaram.length) {
    await Core.log(Pg, req, { entidade: 'importacao', acao: 'RECALCULO_IQF', mudancas: [{ campo: 'fornecedores_com_classe_alterada', de: null, para: mudaram.length }], motivo: 'recálculo geral (importação ou troca de regra)' });
  }
  return { fornecedores: linhas.length, classeAlterada: mudaram.length };
}

module.exports = { importarLista, importarInspecoes, recalcularTodos, _lerLista: lerLista, _lerInspecoes: lerInspecoes, _montarInspecao: montarInspecao, _montarFornecedorDaLista: montarFornecedorDaLista, _dataISO: dataISO };

// services/ctrlVendasIngest.js — ingestão do xlsx mensal da Controladoria (aba "BD",
// nível item) para tab_ctrl_vendas_snapshot. Usa o LEITOR STREAMING do exceljs
// (arquivo de ~41MB / 145k linhas em ~200MB de RAM). Re-importar um mês = DELETE +
// reload (idempotente). Fase 0 do projeto de automação do relatório de vendas.

const ExcelJS = require('exceljs');
const { pool } = require('./pg');

const s = (v) => { const t = (v == null ? '' : String(v)).trim(); return t || null; };
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
// Excel serial (ex.: 43832) -> 'YYYY-MM-DD'. Aceita também Date (se exceljs já converteu).
const dt = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const n = Number(v);
  if (!isFinite(n) || n < 20000) return null;
  return new Date(Math.round((n - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
};

const COLS = ['snapshot_mes', 'filial', 'pedido', 'seq', 'tipo', 'tipo_considerar', 'estatus', 'nf',
  'emissao', 'data_base', 'ano', 'forma_pagto', 'vendedor_cod', 'vendedor_nome', 'cliente_cod', 'tipo_cli',
  'cliente_nome', 'cpf_cnpj', 'codigo', 'descricao', 'unidade', 'classificacao', 'grupo', 'quantidade',
  'unitario', 'total_item', 'total_pedido', 'total_faturado', 'tes', 'cfop', 'destino', 'regiao',
  'municipio', 'cidade', 'chave_cidade', 'considera_qtd', 'vendedor_considerar', 'raw'];
const NC = COLS.length;
const INSERT_SQL = `INSERT INTO tab_ctrl_vendas_snapshot (${COLS.join(',')}) VALUES `;
const BATCH = 400;

function normalizar(get, snapshotMes, headerNames, valores) {
  const raw = {};
  headerNames.forEach((h, i) => { if (h) raw[h] = valores[i + 1]; });   // valores é 1-indexed
  return {
    snapshot_mes: snapshotMes, filial: s(get('Filial')), pedido: s(get('Pedido')), seq: s(get('Seq')),
    tipo: s(get('Tipo')), tipo_considerar: s(get('Tipo a considerar')), estatus: s(get('Estatus')), nf: s(get('NF')),
    emissao: dt(get('Emissão')), data_base: dt(get('Data Base')), ano: num(get('ANO')),
    forma_pagto: s(get('Forma Pagto')), vendedor_cod: s(get('Vendedor')), vendedor_nome: s(get('Nome Vend')),
    cliente_cod: s(get('Cod.Cliente')), tipo_cli: s(get('TipoCli')), cliente_nome: s(get('Nome Cli')), cpf_cnpj: s(get('CPF/CNPJ')),
    codigo: s(get('Codigo')), descricao: s(get('Descrição')), unidade: s(get('Unidade')),
    classificacao: s(get('CLASSIFICAÇÃO')), grupo: s(get('GRUPO')),
    quantidade: num(get('Quantidade')), unitario: num(get('Unitário')), total_item: num(get('Total Item')),
    total_pedido: num(get('Total Pedido')), total_faturado: num(get('Total Faturado')),
    tes: s(get('TES')), cfop: s(get('CFOP')), destino: s(get('Destino')), regiao: s(get('Região')),
    municipio: s(get('Municipio')), cidade: s(get('CIDADE')), chave_cidade: s(get('CHAVE CIDADE')),
    considera_qtd: s(get('CONSIDERA QUANTIDADE?')), vendedor_considerar: s(get('VENDEDOR A CONSIDERAR')),
    raw: JSON.stringify(raw)
  };
}

async function flush(batch) {
  if (!batch.length) return;
  const values = [], params = [];
  batch.forEach((r, i) => {
    const base = i * NC;
    const ph = [];
    for (let k = 0; k < NC; k++) ph.push('$' + (base + k + 1) + (k === NC - 1 ? '::jsonb' : ''));
    values.push('(' + ph.join(',') + ')');
    COLS.forEach(c => params.push(r[c]));
  });
  await pool.query(INSERT_SQL + values.join(','), params);
}

// Importa um arquivo. snapshotMes = 'YYYYMM'. Retorna { ok, linhas, importId }.
async function importar(filePath, snapshotMes, { arquivo = null, importadoPor = null } = {}) {
  if (!/^\d{6}$/.test(String(snapshotMes || ''))) throw new Error('snapshotMes inválido (use YYYYMM).');

  const reg = await pool.query(
    `INSERT INTO tab_ctrl_vendas_import (snapshot_mes, arquivo, status, importado_por)
     VALUES ($1,$2,'PROCESSANDO',$3) RETURNING id`, [snapshotMes, arquivo, importadoPor]);
  const importId = reg.rows[0].id;

  try {
    await pool.query(`DELETE FROM tab_ctrl_vendas_snapshot WHERE snapshot_mes = $1`, [snapshotMes]);

    const wbr = new ExcelJS.stream.xlsx.WorkbookReader(filePath, { sharedStrings: 'cache', worksheets: 'emit', entries: 'ignore' });
    let headerNames = null, hIdx = null, total = 0, batch = [], achouBD = false;

    for await (const ws of wbr) {
      if (ws.name !== 'BD') { for await (const _ of ws) { /* consome */ } continue; }
      achouBD = true;
      for await (const row of ws) {
        const v = row.values;   // 1-indexed
        if (!headerNames) {
          headerNames = v.slice(1).map(x => (x == null ? '' : String(x).trim()));
          hIdx = {}; headerNames.forEach((h, i) => { if (h && !(h in hIdx)) hIdx[h] = i + 1; });
          continue;
        }
        if (!s(v[hIdx['Pedido']])) continue;   // pula linhas vazias/totais sem pedido
        const get = (name) => (hIdx[name] ? v[hIdx[name]] : undefined);
        batch.push(normalizar(get, snapshotMes, headerNames, v));
        if (batch.length >= BATCH) { await flush(batch); total += batch.length; batch = []; }
      }
    }
    if (batch.length) { await flush(batch); total += batch.length; }
    if (!achouBD) throw new Error('aba "BD" não encontrada no arquivo.');

    await pool.query(
      `UPDATE tab_ctrl_vendas_import SET status='CONCLUIDO', linhas=$1, concluido_em=NOW() WHERE id=$2`,
      [total, importId]);
    return { ok: true, linhas: total, importId };
  } catch (e) {
    await pool.query(
      `UPDATE tab_ctrl_vendas_import SET status='ERRO', erro=$1, concluido_em=NOW() WHERE id=$2`,
      [String(e.message).slice(0, 2000), importId]).catch(() => {});
    throw e;
  }
}

module.exports = { importar };

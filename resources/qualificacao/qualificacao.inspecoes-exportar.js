// GET /qualificacao/inspecoes/exportar?formato=xlsx|csv&<filtros> — exporta as
// inspeções do filtro (até 50 mil linhas) no layout da FORM 7.4.3.H + avisos.
// Perm 23001+.

const ExcelJS = require('exceljs');
const Q = require('../../services/qfCore');
const filtro = require('./_filtroInspecoes');

const COLUNAS = [
  ['Rel. Insp.', 'rel_insp', 10], ['Cód. Fornec.', 'fornecedor_codigo', 11], ['Fornecedor', 'fornecedor_nome', 36],
  ['Pedido Compras', 'pedido_compras', 12], ['Cód. do item', 'cod_item', 12], ['Item crítico', 'item_criticidade', 8], ['Nota Fiscal', 'nota_fiscal', 12], ['Lote', 'lote', 12],
  ['Nível Insp.', 'nivel_inspecao', 8], ['Qtd. Rec.', 'qtd_recebida', 9], ['Qtd. Insp.', 'qtd_inspecionada', 9],
  ['ESP.', 'especificacao', 8], ['Critério de Aceitação', 'criterio_aceitacao', 40], ['Resultado', 'resultado_descricao', 40],
  ['Instrumento utilizado', 'instrumento_utilizado', 18], ['Quant. Aprov.', 'qtd_aprovada', 9], ['Quant. Repro.', 'qtd_reprovada', 9],
  ['RNC nº', 'rnc_numero', 12], ['Prazo medido por', 'prazo_rotulo', 10], ['Entrega/coleta prevista', 'data_entrega_prevista', 12], ['Entrega/coleta real', 'data_entrega_real', 12],
  ['Data', 'data_inspecao', 12], ['C', 'indice_c', 6], ['P', 'indice_p', 6], ['N', 'indice_n', 6], ['IQF', 'iqf', 8],
  ['Ajuste manual', 'ajuste', 12], ['Responsável pela Inspeção', 'responsavel_nome', 26], ['Origem', 'origem', 10], ['Liberado pela Qualidade (justificativa)', 'bloqueio_justificativa', 36],
  ['Avisos', 'avisos', 40], ['Excluída', 'excluida', 9]
];
const NUM = new Set(['qtd_recebida', 'qtd_inspecionada', 'qtd_aprovada', 'qtd_reprovada', 'indice_c', 'indice_p', 'indice_n', 'iqf']);
const DATA = new Set(['data_entrega_prevista', 'data_entrega_real', 'data_inspecao']);

module.exports = (app) => ({
  verb: 'get',
  route: '/inspecoes/exportar',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const { where, params } = filtro(req.query);
    const formato = Q.trim(req.query.formato) === 'csv' ? 'csv' : 'xlsx';
    try {
      const linhas = (await Pg.connectAndQuery(
        `SELECT i.* FROM tab_qf_inspecao i WHERE ${where} ORDER BY i.rel_insp LIMIT 50000`, params)).map(i => ({
        ...i,
        ajuste: [i.c_manual && 'C', i.p_manual && 'P', i.n_manual && 'N'].filter(Boolean).join(', '),
        prazo_rotulo: i.tipo_prazo === 'COLETA' ? 'Coleta' : i.tipo_prazo === 'ENTREGA' ? 'Entrega' : '',
        avisos: (i.legado_avisos || []).join('; '),
        excluida: i.excluido ? `sim — ${i.excluido_motivo || ''}` : ''
      }));
      const carimbo = new Date().toISOString().slice(0, 10);

      if (formato === 'csv') {
        const esc = (v) => { const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        const corpo = [COLUNAS.map(c => c[0]).join(';')]
          .concat(linhas.map(l => COLUNAS.map(([, k]) => {
            const v = l[k];
            if (v == null) return '';
            if (DATA.has(k)) return new Date(v).toISOString().slice(0, 10);
            if (NUM.has(k)) return String(Number(v)).replace('.', ',');
            return esc(v);
          }).join(';'))).join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="inspecoes-recebimento-${carimbo}.csv"`);
        return res.end('﻿' + corpo);
      }

      const wb = new ExcelJS.Workbook();
      wb.creator = 'Intranet GNATUS — Qualificação de Fornecedores';
      const ws = wb.addWorksheet('FORM 7.4.3.H', { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = COLUNAS.map(([h, k, w]) => ({ header: h, key: k, width: w }));
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3F82' } };
      ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
      for (const l of linhas) {
        const row = {};
        for (const [, k] of COLUNAS) {
          const v = l[k];
          row[k] = v == null ? null : DATA.has(k) ? new Date(v) : NUM.has(k) ? Number(v) : v;
        }
        const r = ws.addRow(row);
        if (l.nc) r.getCell('iqf').font = { color: { argb: 'FFC9302C' }, bold: true };
      }
      ['data_entrega_prevista', 'data_entrega_real', 'data_inspecao'].forEach(k => { ws.getColumn(k).numFmt = 'dd/mm/yyyy'; });
      ws.autoFilter = { from: 'A1', to: { row: 1, column: COLUNAS.length } };
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="inspecoes-recebimento-${carimbo}.xlsx"`);
      await wb.xlsx.write(res);
      return res.end();
    } catch (err) { return Q.falha(res, 'exportar as inspeções', err); }
  }
});

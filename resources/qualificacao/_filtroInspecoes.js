// Filtro compartilhado da lista e da exportação de inspeções (arquivo com "_" não vira rota).
//
// fornecedorId · q (nº do relatório, PC, NF, item, fornecedor) · de/ate (data da inspeção) ·
// nivel · resultado (CONFORME | NC) · rnc (com | sem) · inspetor · avisos=1 (legado com
// aviso de importação) · origem (INTRANET | PLANILHA) · excluidas=1 (inclui as excluídas) ·
// itemCritico (A | B | C | D | SIM = qualquer) · prazo (ENTREGA | COLETA) · liberadoQualidade=1

const trim = (v) => (v == null ? '' : String(v).trim());
const data = (v) => { const s = trim(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };

module.exports = function filtroInspecoes(qs) {
  const cond = [];
  const p = {};
  if (trim(qs.excluidas) !== '1') cond.push('NOT i.excluido');
  if (qs.fornecedorId) { cond.push('i.fornecedor_id = @fid'); p.fid = Number(qs.fornecedorId); }
  const q = trim(qs.q);
  if (q) {
    cond.push(`(CAST(i.rel_insp AS TEXT) = @q OR i.pedido_compras ILIKE @like OR i.nota_fiscal ILIKE @like OR i.cod_item ILIKE @like
               OR i.fornecedor_codigo = @cod OR i.fornecedor_nome ILIKE @likeNome OR i.lote ILIKE @like)`);
    p.q = q; p.like = `%${q.replace(/^0+(?=\d)/, '')}%`; p.cod = /^\d{1,6}$/.test(q) ? q.padStart(6, '0') : q.toUpperCase(); p.likeNome = `%${q}%`;
  }
  if (data(qs.de)) { cond.push('i.data_inspecao >= @de'); p.de = data(qs.de); }
  if (data(qs.ate)) { cond.push('i.data_inspecao <= @ate'); p.ate = data(qs.ate); }
  if (trim(qs.nivel)) { cond.push('i.nivel_inspecao = @nivel'); p.nivel = trim(qs.nivel); }
  if (trim(qs.resultado) === 'NC') cond.push('i.nc');
  if (trim(qs.resultado) === 'CONFORME') cond.push('NOT i.nc');
  if (trim(qs.rnc) === 'com') cond.push(`COALESCE(NULLIF(UPPER(TRIM(i.rnc_numero)), 'N/A'), '') <> ''`);
  if (trim(qs.rnc) === 'sem') cond.push(`COALESCE(NULLIF(UPPER(TRIM(i.rnc_numero)), 'N/A'), '') = ''`);
  if (trim(qs.inspetor)) { cond.push('i.responsavel_nome ILIKE @insp'); p.insp = `%${trim(qs.inspetor)}%`; }
  if (trim(qs.avisos) === '1') cond.push('i.legado_avisos IS NOT NULL');
  if (['INTRANET', 'PLANILHA'].includes(trim(qs.origem))) { cond.push('i.origem = @origem'); p.origem = trim(qs.origem); }
  if (trim(qs.ajuste) === '1') cond.push('(i.c_manual OR i.p_manual OR i.n_manual)');
  const ic = trim(qs.itemCritico).toUpperCase();
  if (/^[ABCD]$/.test(ic)) { cond.push('i.item_criticidade = @ic'); p.ic = ic; } else if (ic === 'SIM') cond.push('i.item_criticidade IS NOT NULL');
  if (['ENTREGA', 'COLETA'].includes(trim(qs.prazo))) { cond.push('i.tipo_prazo = @tp'); p.tp = trim(qs.prazo); }
  if (trim(qs.liberadoQualidade) === '1') cond.push('i.bloqueio_justificativa IS NOT NULL');
  return { where: cond.length ? cond.join(' AND ') : 'TRUE', params: p };
};

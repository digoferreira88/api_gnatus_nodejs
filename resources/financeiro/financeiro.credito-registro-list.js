// GET /financeiro/credito-registro?bu=&inicio=&fim=&cliente=&cnpj=&pedido=&analista=&resultado=&motivo=&formato=csv
//
// Consulta/relatório dos registros de análise de crédito (só as versões
// VIGENTES por padrão). Filtros: BU, período (criado_em), cliente (cod ou nome),
// CPF/CNPJ, nº pedido, analista, resultado, motivo. formato=csv exporta.
// Perm 8006.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006]);
const CR = require('../../services/creditoRegistro');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

const csvCell = (v) => {
  const s = String(v == null ? '' : v).replace(/"/g, '""');
  return /[",;\n]/.test(s) ? `"${s}"` : s;
};

module.exports = (app) => ({
  verb: 'get',
  route: '/credito-registro',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const q = req.query || {};
    const conds = ['r.vigente = TRUE'];
    const p = {};

    if (trim(q.bu))        { conds.push('r.bu_cod = @bu'); p.bu = trim(q.bu); }
    if (trim(q.inicio))    { conds.push('r.criado_em >= @inicio'); p.inicio = trim(q.inicio); }
    if (trim(q.fim))       { conds.push('r.criado_em < (@fim::date + 1)'); p.fim = trim(q.fim); }
    if (trim(q.cliente))   { conds.push('(r.cliente_cod = @cli OR r.cliente_nome ILIKE @cliLike)'); p.cli = trim(q.cliente); p.cliLike = `%${trim(q.cliente)}%`; }
    if (trim(q.cnpj))      { conds.push("regexp_replace(COALESCE(r.cnpj,''),'[^0-9]','','g') LIKE @cnpj"); p.cnpj = `%${trim(q.cnpj).replace(/\D/g, '')}%`; }
    if (trim(q.pedido))    { conds.push('r.pedido = @pedido'); p.pedido = trim(q.pedido); }
    if (trim(q.analista))  { conds.push('(r.analista_id = @analistaId OR r.analista_nome ILIKE @analistaLike)'); p.analistaId = Number(q.analista) || -1; p.analistaLike = `%${trim(q.analista)}%`; }
    if (trim(q.resultado)) { conds.push('r.resultado = @resultado'); p.resultado = trim(q.resultado); }
    if (trim(q.motivo))    { conds.push('@motivo = ANY(r.motivos)'); p.motivo = trim(q.motivo); }
    if (trim(q.canal))     { conds.push('r.canal = @canal'); p.canal = trim(q.canal); }

    const where = conds.join(' AND ');
    const sql = `
      SELECT r.id, r.grupo_id, r.versao,
             r.bu_cod, r.bu_nome, r.pedido, r.cliente_cod, r.cliente_loja, r.cliente_nome, r.cnpj,
             r.valor_total, r.valor_entrada, r.parcelas_qtd, r.parcelas_valor,
             r.tipo_analise, r.canal, r.canal_origem, r.resultado, r.motivos, r.parecer,
             r.analista_nome, r.criado_em,
             (r.versao > 1) AS editado,
             (SELECT COUNT(*) FROM tab_credito_anexo a WHERE a.registro_id = r.grupo_id) AS qtd_anexos
        FROM tab_credito_registro r
       WHERE ${where}
       ORDER BY r.criado_em DESC
       LIMIT 5000`;

    try {
      const rows = await Pg.connectAndQuery(sql, p);

      if (trim(q.formato).toLowerCase() === 'csv') {
        const head = ['Data/Hora', 'BU', 'Pedido', 'Cliente', 'CPF/CNPJ', 'Valor Total', 'Entrada',
          'Parcelas', 'Vlr Parcela', 'Tipo', 'Canal', 'Origem', 'Resultado', 'Motivos', 'Parecer', 'Analista', 'Versão'];
        const linhas = rows.map(r => [
          r.criado_em ? new Date(r.criado_em).toLocaleString('pt-BR') : '',
          r.bu_nome || r.bu_cod || '', r.pedido || '',
          `${trim(r.cliente_cod)}${r.cliente_loja ? '/' + trim(r.cliente_loja) : ''} ${trim(r.cliente_nome)}`.trim(),
          r.cnpj || '', N(r.valor_total).toFixed(2), N(r.valor_entrada).toFixed(2),
          N(r.parcelas_qtd), N(r.parcelas_valor).toFixed(2),
          r.tipo_analise || '', r.canal || '', r.canal_origem || '',
          r.resultado || '', (Array.isArray(r.motivos) ? r.motivos.join('; ') : ''),
          (r.parecer || '').replace(/\r?\n/g, ' '), r.analista_nome || '', r.versao
        ].map(csvCell).join(';'));
        const csv = '﻿' + [head.join(';'), ...linhas].join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="registros-credito-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.send(csv);
      }

      const registros = rows.map(r => ({
        id: r.id, grupoId: r.grupo_id, versao: r.versao, editado: r.editado,
        buCod: trim(r.bu_cod), buNome: trim(r.bu_nome),
        pedido: trim(r.pedido), clienteCod: trim(r.cliente_cod), clienteLoja: trim(r.cliente_loja),
        clienteNome: trim(r.cliente_nome), cnpj: trim(r.cnpj),
        valorTotal: N(r.valor_total), valorEntrada: N(r.valor_entrada),
        parcelasQtd: N(r.parcelas_qtd), parcelasValor: N(r.parcelas_valor),
        tipoAnalise: trim(r.tipo_analise), canal: trim(r.canal), canalOrigem: trim(r.canal_origem),
        resultado: trim(r.resultado), motivos: Array.isArray(r.motivos) ? r.motivos : [],
        parecer: trim(r.parecer), analistaNome: trim(r.analista_nome), criadoEm: r.criado_em,
        qtdAnexos: N(r.qtd_anexos)
      }));

      // KPIs do recorte
      const kpis = {
        total: registros.length,
        aprovados: registros.filter(r => CR.ehAprovacao(r.resultado)).length,
        reprovados: registros.filter(r => r.resultado === 'Reprovado').length,
        pendentes: registros.filter(r => r.resultado === 'Solicitar Documentação').length,
        valorTotal: +registros.reduce((s, r) => s + r.valorTotal, 0).toFixed(2)
      };

      return res.json({
        opcoes: { resultados: CR.RESULTADOS, motivos: CR.MOTIVOS, tiposAnalise: CR.TIPOS_ANALISE, canais: CR.CANAIS, canalOrigens: CR.CANAL_ORIGENS },
        kpis, registros, geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('financeiro/credito-registro list:', err);
      return res.status(500).json({ message: 'Erro ao consultar registros: ' + err.message });
    }
  }
});

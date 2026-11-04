// GET /financeiro/credito-registro?bu=&inicio=&fim=&cliente=&cnpj=&pedido=&analista=&resultado=&motivo=&canal=&repetidos=1&formato=csv
//
// Consulta/relatório dos registros de análise de crédito (só as versões
// VIGENTES por padrão). Filtros: BU, período (criado_em), cliente (cod ou nome),
// CPF/CNPJ, nº pedido, analista, resultado, motivo, canal e "repetidos" (só
// CPF/CNPJ analisados mais de uma vez). formato=csv exporta.
// Cada registro traz a posição dele entre as análises do mesmo CPF/CNPJ
// (ordemDoc de qtdDoc). Perm 8006 (edição) ou 8007 (somente visualização).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006, 8007]);
const CR = require('../../services/creditoRegistro');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

const csvCell = (v) => {
  const s = String(v == null ? '' : v).replace(/"/g, '""');
  return /[",;\n]/.test(s) ? `"${s}"` : s;
};
const dataBR = (ymd) => (ymd ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}` : '');
const numBR = (n) => (n == null ? '' : Number(n).toFixed(2).replace('.', ','));

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
    if (CR.soDig(q.cnpj))  { conds.push('r.documento LIKE @cnpj'); p.cnpj = `%${CR.soDig(q.cnpj)}%`; }
    if (trim(q.pedido))    { conds.push('r.pedido = @pedido'); p.pedido = trim(q.pedido); }
    if (trim(q.analista))  { conds.push('(r.analista_id = @analistaId OR r.analista_nome ILIKE @analistaLike)'); p.analistaId = Number(q.analista) || -1; p.analistaLike = `%${trim(q.analista)}%`; }
    if (trim(q.resultado)) { conds.push('r.resultado = @resultado'); p.resultado = trim(q.resultado); }
    if (trim(q.motivo))    { conds.push('@motivo = ANY(r.motivos)'); p.motivo = trim(q.motivo); }
    if (trim(q.canal))     { conds.push('r.canal = @canal'); p.canal = trim(q.canal); }
    if (trim(q.repetidos) === '1') {
      conds.push(`r.documento IS NOT NULL AND EXISTS (SELECT 1 FROM tab_credito_registro x
                   WHERE x.vigente AND x.documento = r.documento AND x.grupo_id <> r.grupo_id)`);
    }

    const where = conds.join(' AND ');
    // ordem_doc: posição da análise entre as do mesmo CPF/CNPJ (grupo_id = id da
    // 1ª versão, cresce com a data de registro).
    const sql = `
      SELECT ${CR.COLS},
             (SELECT COUNT(*) FROM tab_credito_anexo a WHERE a.registro_id = r.grupo_id) AS qtd_anexos,
             CASE WHEN r.documento IS NULL THEN 0 ELSE
               (SELECT COUNT(*) FROM tab_credito_registro x WHERE x.vigente AND x.documento = r.documento) END AS qtd_doc,
             CASE WHEN r.documento IS NULL THEN 0 ELSE
               (SELECT COUNT(*) FROM tab_credito_registro x WHERE x.vigente AND x.documento = r.documento AND x.grupo_id <= r.grupo_id) END AS ordem_doc
        FROM tab_credito_registro r
       WHERE ${where}
       ORDER BY r.criado_em DESC
       LIMIT 5000`;

    try {
      const rows = await Pg.connectAndQuery(sql, p);
      const registros = rows.map(r => ({
        ...CR.mapRegistro(r),
        qtdAnexos: N(r.qtd_anexos), qtdDoc: N(r.qtd_doc), ordemDoc: N(r.ordem_doc)
      }));

      if (trim(q.formato).toLowerCase() === 'csv') {
        const head = ['Data/Hora', 'Recebida em', 'BU', 'Pedido', 'Cliente', 'CPF/CNPJ', 'Análise do CPF/CNPJ', 'Valor Total', 'Entrada',
          'Parcelas', 'Vlr Parcela', 'Tipo', 'Canal', 'Origem', 'Resultado', 'Motivos',
          'Cond. forma de pagamento', 'Cond. valor máximo', 'Cond. entrada mínima %', 'Cond. parcelas máx.', 'Cond. validade', 'Cond. observação',
          'Parecer', 'Analista', 'Versão'];
        const linhas = registros.map(r => [
          r.criadoEm ? new Date(r.criadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '',
          r.solicitadoEm ? new Date(r.solicitadoEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '',
          r.buNome || r.buCod || '', r.pedido || '',
          `${r.clienteCod}${r.clienteLoja ? '/' + r.clienteLoja : ''} ${r.clienteNome}`.trim(),
          r.documento || r.cnpj || '', r.qtdDoc > 1 ? `${r.ordemDoc} de ${r.qtdDoc}` : '',
          numBR(r.valorTotal), numBR(r.valorEntrada), r.parcelasQtd, numBR(r.parcelasValor),
          r.tipoAnalise || '', r.canal || '', r.canalOrigem || '',
          r.resultado || '', r.motivos.join('; '),
          r.condicoes?.formaPagamento || '', numBR(r.condicoes?.valorMax), numBR(r.condicoes?.entradaMinPct),
          r.condicoes?.parcelasMax ?? '', dataBR(r.condicoes?.validade), r.condicoes?.observacao || '',
          (r.parecer || '').replace(/\r?\n/g, ' '), r.analistaNome || '', r.versao
        ].map(csvCell).join(';'));
        const csv = '﻿' + [head.join(';'), ...linhas].join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="registros-credito-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.send(csv);
      }

      // KPIs do recorte
      const kpis = {
        total: registros.length,
        aprovados: registros.filter(r => CR.ehAprovacao(r.resultado)).length,
        reprovados: registros.filter(r => r.resultado === 'Reprovado').length,
        pendentes: registros.filter(r => r.resultado === 'Solicitar Documentação').length,
        reanalises: registros.filter(r => r.ordemDoc > 1).length,
        valorTotal: +registros.reduce((s, r) => s + r.valorTotal, 0).toFixed(2)
      };

      return res.json({
        opcoes: {
          resultados: CR.RESULTADOS, motivos: CR.MOTIVOS, tiposAnalise: CR.TIPOS_ANALISE, canais: CR.CANAIS,
          canalOrigens: CR.CANAL_ORIGENS, formasPagamento: CR.FORMAS_PAGAMENTO, janelaDias: CR.JANELA_DUPLICIDADE_DIAS
        },
        kpis, registros, geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('financeiro/credito-registro list:', err);
      return res.status(500).json({ message: 'Erro ao consultar registros: ' + err.message });
    }
  }
});

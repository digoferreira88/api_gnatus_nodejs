// Auditoria detalhada da natureza 211 (Financeiro) — gera lista completa
// dos lançamentos do período, classificados por palavra-chave do histórico,
// para que o time financeiro/contábil reclassifique no Protheus criando
// subnaturezas adequadas (21102 Amortização, 21103 IOF, etc).

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

const RX_AMORTIZACAO = /AMORTIZ|FINIMP|PRINCIPAL|INVOICE|RECOMPRA/i;
const RX_JUROS_REAL  = /JUROS|IOF|TAXA|TARIFA|CUSTAS|MULTA|MORA|CORRETAGEM/i;
const classificar = (h) => {
  const s = String(h || '');
  if (RX_AMORTIZACAO.test(s)) return 'AMORTIZACAO';
  if (RX_JUROS_REAL.test(s))  return 'JUROS';
  return 'PENDENTE';
};

module.exports = (app) => ({
  verb: 'get',
  route: '/dre/auditoria-211',
  // Perm 10001 (12/08/2026): estava sem requirePerm (mesmo caso do /dre).
  middlewares: [require('../../middlewares/requirePerm')(app)([10001])],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const inicio = trim(req.query.inicio);
    const fim    = trim(req.query.fim);
    if (!/^\d{8}$/.test(inicio) || !/^\d{8}$/.test(fim)) {
      return res.status(400).json({ message: 'Parâmetros inicio/fim devem ser YYYYMMDD.' });
    }

    try {
      const sql = `
        SELECT RTRIM(se2.E2_NATUREZ) natureza,
               RTRIM(se2.E2_PREFIXO) prefixo,
               RTRIM(se2.E2_NUM)     numero,
               RTRIM(se2.E2_PARCELA) parcela,
               RTRIM(se2.E2_TIPO)    tipoTitulo,
               RTRIM(se2.E2_FORNECE) fornCod,
               RTRIM(se2.E2_LOJA)    fornLoja,
               RTRIM(se2.E2_NOMFOR)  fornNome,
               RTRIM(se2.E2_HIST)    historico,
               se2.E2_EMISSAO        emissao,
               se2.E2_VENCTO         vencimento,
               se2.E2_VALOR          valor,
               se2.E2_SALDO          saldo,
               se2.E2_BAIXA          baixa
          FROM SE2010 se2 WITH (NOLOCK)
         WHERE se2.D_E_L_E_T_ <> '*'
           AND se2.E2_FILIAL = '01'
           AND se2.E2_EMISSAO BETWEEN @inicio AND @fim
           AND LEFT(RTRIM(se2.E2_NATUREZ), 3) = '211'
         ORDER BY se2.E2_VALOR DESC
      `;
      const rows = await Protheus.connectAndQuery(sql, { inicio, fim });

      const lancamentos = rows.map(r => {
        const valor = toN(r.valor);
        const cls = classificar(r.historico);
        return {
          natureza: trim(r.natureza),
          prefixo: trim(r.prefixo),
          numero: trim(r.numero),
          parcela: trim(r.parcela),
          tipoTitulo: trim(r.tipoTitulo),
          fornCod: trim(r.fornCod),
          fornLoja: trim(r.fornLoja),
          fornNome: trim(r.fornNome),
          historico: trim(r.historico),
          emissao: trim(r.emissao),
          vencimento: trim(r.vencimento),
          valor,
          saldo: toN(r.saldo),
          baixado: !!trim(r.baixa),
          classificacao: cls,
          impactaDre: cls === 'JUROS'
        };
      });

      const resumo = { JUROS: { qtd: 0, total: 0 }, AMORTIZACAO: { qtd: 0, total: 0 }, PENDENTE: { qtd: 0, total: 0 } };
      lancamentos.forEach(l => {
        resumo[l.classificacao].qtd += 1;
        resumo[l.classificacao].total += l.valor;
      });
      const total = lancamentos.reduce((s, l) => s + l.valor, 0);

      return res.json({
        periodo: { inicio, fim },
        geradoEm: new Date().toISOString(),
        totalLancamentos: lancamentos.length,
        totalValor: total,
        resumo: {
          juros:       { ...resumo.JUROS,       pct: total > 0 ? (resumo.JUROS.total / total) * 100 : 0 },
          amortizacao: { ...resumo.AMORTIZACAO, pct: total > 0 ? (resumo.AMORTIZACAO.total / total) * 100 : 0 },
          pendente:    { ...resumo.PENDENTE,    pct: total > 0 ? (resumo.PENDENTE.total / total) * 100 : 0 }
        },
        criterios: {
          juros:       'Histórico contém: JUROS, IOF, TAXA, TARIFA, CUSTAS, MULTA, MORA, CORRETAGEM',
          amortizacao: 'Histórico contém: AMORTIZ, FINIMP, PRINCIPAL, INVOICE, RECOMPRA',
          pendente:    'Demais lançamentos (sem palavra-chave reconhecida)'
        },
        recomendacao: 'Criar subnaturezas no Protheus para separar: 21101 Juros bancários · 21102 Amortização · 21103 IOF/Tarifas · 21104 Financiamento de Importação. Reclassificar os lançamentos PENDENTES manualmente.',
        lancamentos
      });
    } catch (err) {
      console.error('Erro em gerencia/dre-auditoria-211:', err);
      return res.status(500).json({ message: 'Erro ao gerar auditoria.' });
    }
  }
});

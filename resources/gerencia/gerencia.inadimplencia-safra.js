// GET /gerencia/inadimplencia-safra
// Visão DIRETORIA da inadimplência: % sobre a SAFRA = ano de emissão do PEDIDO
// de venda (C5_EMISSAO; fallback = emissão do título quando não há pedido), nos
// títulos com a forma de pagamento escolhida (default boleto). Para cada
// canal (C5_ZTIPO) x ano da safra calcula:
//   - faturado  = SUM(E1_VALOR) dos títulos emitidos no ano (denominador)
//   - vencido   = SUM(E1_SALDO) em aberto e vencido hoje
//   - aberto    = SUM(E1_SALDO) em aberto (vencido + a vencer)
//   e as versões "sem acordos" (descontando clientes com status NEGOCIANDO,
//   ACORDO_EM_ANDAMENTO, RETENÇÃO ou CONFISSÃO DE DÍVIDA no módulo de Cobrança).
// Clientes com status DEVOLUÇÃO ou AJUSTE INTERNO são removidos por completo da
// análise. JURÍDICO e PERDA contam como inadimplência. RETENÇÃO permanece no
// Total mas é descontada de "Sem acordos" (como NEGOCIANDO/ACORDO EM ANDAMENTO) — 01/07/2026.
// Mantém o dashboard de Cobrança intacto — é uma visão paralela em Gerência.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([10002, 0]);
const trim = (v) => String(v == null ? '' : v).trim();
const num = (v) => Number(v || 0);

// C5_ZTIPO -> canal (tabela Z1 do Protheus). Códigos não mapeados caem em "Outros".
const CANAL = {
  COA: 'Atacado', COR: 'Corporativo', COV: 'Varejo', DIG: 'Digital', REP: 'Representação',
  FSH: 'Franquias', FRA: 'Franquias', FEX: 'Franquias', TFQ: 'Franquias', FGA: 'Franquias',
  ASS: 'Assistência Técnica', POS: 'Assistência Técnica',
  LIC: 'Licitação', OUT: 'Outros', RDC: 'Outros', GSH: 'Outros'
};
// Códigos não-comerciais — fora do cálculo (devoluções, eventos, ajustes).
const EXCLUIR = new Set(['DVA', 'DVC', 'DVR', 'DVT', 'DVV', 'S24', 'S25', 'RED', 'IND', 'GSV']);
const ORDEM_CANAIS = ['Atacado', 'Corporativo', 'Varejo', 'Digital', 'Representação', 'Franquias', 'Assistência Técnica', 'Licitação', 'Outros'];

module.exports = (app) => ({
  verb: 'get',
  route: '/inadimplencia-safra',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    try {
      const anoAtual = new Date().getFullYear();
      const anoMax = Number(req.query.anoMax) || anoAtual;
      const anoMin = Number(req.query.anoMin) || (anoMax - 3);
      const forma = trim(req.query.forma);                 // '4' boleto, '' = todas
      const anos = [];
      for (let a = anoMin; a <= anoMax; a++) anos.push(String(a));

      // 1) clientes DESCONTADOS do "sem acordos" (mas presentes no Total):
      //    status NEGOCIANDO, ACORDO_EM_ANDAMENTO, RETENÇÃO ou CONFISSÃO DE DÍVIDA
      //    na Cobrança, mais qualquer cliente marcado manualmente na carteira NEGOCIACAO.
      const negocRows = await Pg.connectAndQuery(
        `SELECT cliente_cod, cliente_loja FROM tab_cobranca_status_cliente
           WHERE UPPER(TRIM(status)) IN ('NEGOCIANDO', 'ACORDO_EM_ANDAMENTO', 'RETENCAO', 'CONFISSAO_DIVIDA')
         UNION
         SELECT cliente_cod, cliente_loja FROM tab_cobranca_atribuicao
           WHERE UPPER(TRIM(carteira)) = 'NEGOCIACAO'`, {});
      const negocKeys = negocRows.map(r => `${trim(r.cliente_cod)}|${trim(r.cliente_loja)}`);
      // condição SQL p/ a parcela em negociação (false se ninguém classificado)
      const keysToSql = (keys) => keys.length
        ? `(RTRIM(se1.E1_CLIENTE)+'|'+RTRIM(se1.E1_LOJA)) IN (${keys.map(k => `'${k.replace(/'/g, "''")}'`).join(',')})`
        : `1=0`;
      const condNegoc = keysToSql(negocKeys);

      // 1b) clientes removidos POR COMPLETO da análise (não entram no faturado
      //     da safra nem na inadimplência): DEVOLUÇÃO e AJUSTE INTERNO.
      //     (JURÍDICO e PERDA contam normal; RETENÇÃO fica no Total mas é
      //     descontada do "Sem acordos" — tratada junto da negociação, acima.)
      const STATUS_FORA = ['DEVOLUCAO', 'AJUSTE_INTERNO'];
      const foraRows = await Pg.connectAndQuery(
        `SELECT cliente_cod, cliente_loja FROM tab_cobranca_status_cliente
           WHERE UPPER(TRIM(status)) IN (${STATUS_FORA.map(s => `'${s}'`).join(', ')})`, {});
      const foraKeys = foraRows.map(r => `${trim(r.cliente_cod)}|${trim(r.cliente_loja)}`);
      const filtroFora = `AND NOT (${keysToSql(foraKeys)})`;

      const filtroForma = forma ? `AND se1.E1_FORMAPG = @forma` : '';
      // Safra = ANO DO PEDIDO DE VENDA (C5_EMISSAO). Fallback p/ a emissão do
      // título quando não há pedido vinculado (títulos avulsos/financeiros).
      const anoSafra = `LEFT(CASE WHEN c5.C5_EMISSAO IS NOT NULL AND LEN(RTRIM(c5.C5_EMISSAO)) = 8 THEN c5.C5_EMISSAO ELSE se1.E1_EMISSAO END, 4)`;
      const sql = `
        SELECT ${anoSafra} ano, RTRIM(c5.C5_ZTIPO) bu,
               SUM(se1.E1_VALOR) faturado,
               SUM(CASE WHEN se1.E1_SALDO > 0 AND se1.E1_VENCREA <= GETDATE() THEN se1.E1_SALDO ELSE 0 END) vencido,
               SUM(CASE WHEN se1.E1_SALDO > 0 THEN se1.E1_SALDO ELSE 0 END) aberto,
               SUM(CASE WHEN se1.E1_SALDO > 0 AND se1.E1_VENCREA <= GETDATE() AND ${condNegoc} THEN se1.E1_SALDO ELSE 0 END) vencido_negoc,
               SUM(CASE WHEN se1.E1_SALDO > 0 AND ${condNegoc} THEN se1.E1_SALDO ELSE 0 END) aberto_negoc
          FROM SE1010 se1 WITH (NOLOCK)
          LEFT JOIN SC5010 c5 WITH (NOLOCK)
            ON c5.C5_FILIAL = se1.E1_FILIAL AND RTRIM(c5.C5_NUM) = RTRIM(se1.E1_PEDIDO) AND c5.D_E_L_E_T_ <> '*'
         WHERE se1.D_E_L_E_T_ <> '*' AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
           AND ${anoSafra} BETWEEN @anoMin AND @anoMax
           ${filtroFora}
           ${filtroForma}
         GROUP BY ${anoSafra}, RTRIM(c5.C5_ZTIPO)`;
      const rows = await Protheus.connectAndQuery(sql, { anoMin: String(anoMin), anoMax: String(anoMax), forma });

      // 2) agrega por canal x ano (aplica mapa de canais + exclusões)
      const cell = () => ({ faturado: 0, vencido: 0, aberto: 0, vencidoSA: 0, abertoSA: 0 });
      const canais = new Map();   // canal -> { ano -> cell }
      const totais = {};          // ano -> cell (Total Geral)
      anos.forEach(a => { totais[a] = cell(); });

      for (const r of rows) {
        const bu = trim(r.bu).toUpperCase();
        if (EXCLUIR.has(bu)) continue;
        const ano = trim(r.ano);
        if (!totais[ano]) continue;
        const canal = CANAL[bu] || 'Outros';
        if (!canais.has(canal)) { const m = {}; anos.forEach(a => m[a] = cell()); canais.set(canal, m); }
        const c = canais.get(canal)[ano], t = totais[ano];
        const fat = num(r.faturado), venc = num(r.vencido), ab = num(r.aberto);
        const vencSA = venc - num(r.vencido_negoc), abSA = ab - num(r.aberto_negoc);
        for (const alvo of [c, t]) {
          alvo.faturado += fat; alvo.vencido += venc; alvo.aberto += ab;
          alvo.vencidoSA += vencSA; alvo.abertoSA += abSA;
        }
      }

      const pct = (n, d) => d > 0 ? +(n / d * 100).toFixed(2) : 0;
      const fmtCell = (x) => ({
        faturado: +x.faturado.toFixed(2), vencido: +x.vencido.toFixed(2), aberto: +x.aberto.toFixed(2),
        vencidoSA: +x.vencidoSA.toFixed(2), abertoSA: +x.abertoSA.toFixed(2),
        pctVencido: pct(x.vencido, x.faturado), pctAberto: pct(x.aberto, x.faturado),
        pctVencidoSA: pct(x.vencidoSA, x.faturado), pctAbertoSA: pct(x.abertoSA, x.faturado)
      });

      const canaisOut = [...canais.entries()]
        .sort((a, b) => (ORDEM_CANAIS.indexOf(a[0]) + 1 || 99) - (ORDEM_CANAIS.indexOf(b[0]) + 1 || 99))
        .map(([canal, porAno]) => {
          const out = {}; anos.forEach(a => out[a] = fmtCell(porAno[a]));
          return { canal, porAno: out };
        });
      const totalOut = {}; anos.forEach(a => totalOut[a] = fmtCell(totais[a]));

      return res.json({
        anos,
        forma: forma || 'todas',
        negociacaoConfigurada: negocKeys.length,   // 0 = "sem acordos" sai igual ao "total"
        excluidosAnalise: foraKeys.length,         // clientes PERDA/JURIDICO/DEVOLUCAO/RETENCAO fora da análise
        canais: canaisOut,
        total: totalOut
      });
    } catch (err) {
      console.error('Erro inadimplencia-safra:', err);
      return res.status(500).json({ message: 'Erro ao calcular inadimplência por safra: ' + err.message });
    }
  }
});

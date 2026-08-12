// Drill-down de lançamentos por natureza no DRE.
// Carrega sob demanda quando o usuário expande uma linha de natureza
// no relatório (ex: "20407 SERVIÇOS DE PJ" → lista os 65 títulos).

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/dre/lancamentos',
  // Perm 10001 (12/08/2026): estava sem requirePerm — drill titulo a titulo aberto
  // a qualquer logado. O gestor restrito (10003) nao acessa esta visao.
  middlewares: [require('../../middlewares/requirePerm')(app)([10001])],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const natureza = trim(req.query.natureza);
    const inicio   = trim(req.query.inicio);
    const fim      = trim(req.query.fim);
    const agrupador = (trim(req.query.agrupador) || 'natureza').toLowerCase();

    if (!natureza) {
      return res.status(400).json({ message: 'Parâmetro natureza é obrigatório.' });
    }
    if (!/^\d{8}$/.test(inicio) || !/^\d{8}$/.test(fim)) {
      return res.status(400).json({ message: 'Parâmetros inicio/fim devem ser YYYYMMDD.' });
    }
    if (!['natureza', 'conta'].includes(agrupador)) {
      return res.status(400).json({ message: 'agrupador deve ser "natureza" ou "conta".' });
    }

    try {
      const filial = '01';
      const porConta = agrupador === 'conta';
      const colCampo = porConta ? 'E2_CONTAD' : 'E2_NATUREZ';
      // No modo conta, exclui MP (naturezas 201/202/203) que vai pelo CMV.
      // Evita double-counting com SD2.D2_CUSTO1.
      const filtroMP = porConta ? `AND LEFT(RTRIM(se2.E2_NATUREZ), 3) NOT IN ('201','202','203')` : '';

      const sql = `
        SELECT RTRIM(se2.E2_PREFIXO) prefixo,
               RTRIM(se2.E2_NUM)     numero,
               RTRIM(se2.E2_PARCELA) parcela,
               RTRIM(se2.E2_TIPO)    tipoTitulo,
               RTRIM(se2.E2_FORNECE) fornCod,
               RTRIM(se2.E2_LOJA)    fornLoja,
               RTRIM(se2.E2_NOMFOR)  fornNome,
               RTRIM(se2.E2_HIST)    historico,
               RTRIM(se2.E2_NATUREZ) natureza,
               RTRIM(se2.E2_CONTAD)  conta,
               se2.E2_EMISSAO        emissao,
               se2.E2_VENCTO         vencimento,
               se2.E2_VALOR          valor,
               se2.E2_SALDO          saldo
          FROM SE2010 se2 WITH (NOLOCK)
         WHERE se2.D_E_L_E_T_ <> '*'
           AND se2.E2_FILIAL = @filial
           AND RTRIM(se2.${colCampo}) = @natureza
           AND se2.E2_EMISSAO BETWEEN @inicio AND @fim
           ${filtroMP}
         ORDER BY se2.E2_EMISSAO, se2.E2_VALOR DESC
      `;
      const rows = await Protheus.connectAndQuery(sql, { filial, natureza, inicio, fim });

      const lancamentos = rows.map(r => {
        const valor = toN(r.valor);
        const saldo = toN(r.saldo);
        return {
          prefixo: trim(r.prefixo),
          numero: trim(r.numero),
          parcela: trim(r.parcela),
          tipoTitulo: trim(r.tipoTitulo),
          fornCod: trim(r.fornCod),
          fornLoja: trim(r.fornLoja),
          fornNome: trim(r.fornNome),
          historico: trim(r.historico),
          natureza: trim(r.natureza),
          conta: trim(r.conta),
          emissao: trim(r.emissao),
          vencimento: trim(r.vencimento),
          valor,
          saldo,
          baixado: saldo === 0
        };
      });

      const totalValor = lancamentos.reduce((s, l) => s + l.valor, 0);

      return res.json({
        natureza,           // codigo passado (pode ser natureza OU conta)
        agrupador,
        periodo: { inicio, fim },
        qtd: lancamentos.length,
        totalValor,
        lancamentos
      });
    } catch (err) {
      console.error('Erro em gerencia/dre/lancamentos:', err);
      return res.status(500).json({ message: 'Erro ao carregar lançamentos.' });
    }
  }
});

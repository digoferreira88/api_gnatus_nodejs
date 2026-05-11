// GET /financeiro/boleto-elegiveis — titulos do SE1 elegiveis pra envio a banco.
// Filtros via query: busca, dataIni, dataFim (vencimento), valorMin,
//   banco (E1_PORTADO), formaPgto (E1_FORMAPG, aceita lista CSV),
//   emissaoIni, emissaoFim (E1_EMISSAO).
//
// REGRA NOVA (Mai/2026): mostra APENAS titulos que JA TEM portador
// definido no Protheus (E1_PORTADO preenchido com um banco comercial).
// O fluxo real eh: financeiro define o portador no ESF050 do Protheus
// primeiro, e o operador da Intranet escolhe quais desses ir pro lote.
// Titulos sem portador (carteira CP/RF ou vazio) nao entram aqui — sao
// tratados em outro fluxo.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

// Bancos comerciais que efetivamente recebem boleto (mesma lista do endpoint
// /boleto-bancos). FIDCs/cartao/aplicacao ficam de fora.
const BANCOS_COBRANCA = ['001', '033', '104', '237', '341', '422', '748', '756'];

// Formas de pagamento elegiveis pra boleto bancario na Gnatus.
// Default explicito caso o operador nao filtre: cod 4 (Boleto), A (Futuro
// Garantido), B (Antecipacao Parcelada) — confirmados com o financeiro.
const FORMAS_BOLETO_DEFAULT = ['4', 'A', 'B'];
const FORMAS_NOMES = {
  '4': 'Boleto Bancário',
  'A': 'Futuro Garantido',
  'B': 'Antecipação Parcelada'
};

module.exports = (app) => ({
  verb: 'get',
  route: '/boleto-elegiveis',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const limit = Math.min(Math.max(Number(req.query.limit || 1000), 1), 5000);
    const params = { lim: limit };
    const conds = [];

    if (req.query.busca) {
      params.busca = String(req.query.busca).toUpperCase();
      conds.push(`AND (UPPER(sa1.A1_NOME) LIKE '%' + @busca + '%' OR RTRIM(se1.E1_CLIENTE) = @busca OR RTRIM(se1.E1_NUM) LIKE '%' + @busca + '%')`);
    }
    // Vencimento (mantido) — agora opcional
    if (req.query.dataIni && /^\d{8}$/.test(String(req.query.dataIni))) {
      params.di = String(req.query.dataIni);
      conds.push(`AND se1.E1_VENCREA >= @di`);
    }
    if (req.query.dataFim && /^\d{8}$/.test(String(req.query.dataFim))) {
      params.df = String(req.query.dataFim);
      conds.push(`AND se1.E1_VENCREA <= @df`);
    }
    // Emissao (novo)
    if (req.query.emissaoIni && /^\d{8}$/.test(String(req.query.emissaoIni))) {
      params.ei = String(req.query.emissaoIni);
      conds.push(`AND se1.E1_EMISSAO >= @ei`);
    }
    if (req.query.emissaoFim && /^\d{8}$/.test(String(req.query.emissaoFim))) {
      params.ef = String(req.query.emissaoFim);
      conds.push(`AND se1.E1_EMISSAO <= @ef`);
    }
    if (req.query.valorMin && Number(req.query.valorMin) > 0) {
      params.vmin = Number(req.query.valorMin);
      conds.push(`AND se1.E1_SALDO >= @vmin`);
    }
    // Filtro por banco (E1_PORTADO) — se o operador escolheu, restringe a esse
    if (req.query.banco) {
      params.banco = String(req.query.banco);
      conds.push(`AND RTRIM(se1.E1_PORTADO) = @banco`);
    }
    // Filtro por forma de pgto — aceita CSV ("4,A,B") ou um cod so. Sem param,
    // aplica o default (4, A, B) — boletos efetivos.
    const formasInput = trim(req.query.formaPgto);
    const formasLista = formasInput
      ? formasInput.split(',').map(s => trim(s)).filter(Boolean)
      : FORMAS_BOLETO_DEFAULT;
    if (formasLista.length > 0) {
      const formaIn = formasLista.map((_, i) => `@fp${i}`).join(',');
      formasLista.forEach((f, i) => { params[`fp${i}`] = f; });
      conds.push(`AND RTRIM(se1.E1_FORMAPG) IN (${formaIn})`);
    }

    const bancosIn = BANCOS_COBRANCA.map(c => `'${c}'`).join(',');
    const sql = `
      SELECT TOP ${limit}
        RTRIM(se1.E1_PREFIXO) prefixo,
        RTRIM(se1.E1_NUM)     numero,
        RTRIM(se1.E1_PARCELA) parcela,
        RTRIM(se1.E1_TIPO)    tipo,
        RTRIM(se1.E1_CLIENTE) clienteCod,
        RTRIM(se1.E1_LOJA)    clienteLoja,
        RTRIM(COALESCE(NULLIF(sa1.A1_NOME, ''), se1.E1_NOMCLI)) clienteNome,
        RTRIM(sa1.A1_CGC)     clienteCnpj,
        RTRIM(sa1.A1_EMAIL)   clienteEmail,
        RTRIM(sa1.A1_DDD)     clienteDdd,
        RTRIM(sa1.A1_TEL)     clienteTel,
        RTRIM(sa1.A1_EST)     clienteUf,
        se1.E1_EMISSAO        emissao,
        se1.E1_VENCREA        vencimento,
        se1.E1_VALOR          valor,
        se1.E1_SALDO          saldo,
        RTRIM(se1.E1_PORTADO) portador,
        RTRIM(se1.E1_FORMAPG) formaPgto,
        RTRIM(se1.E1_NUMBOR)  bordero
      FROM SE1010 se1 WITH (NOLOCK)
      LEFT JOIN SA1010 sa1 WITH (NOLOCK)
        ON sa1.A1_COD = se1.E1_CLIENTE AND sa1.A1_LOJA = se1.E1_LOJA
       AND sa1.D_E_L_E_T_ <> '*'
      WHERE se1.D_E_L_E_T_ <> '*'
        AND se1.E1_FILIAL = '01'
        AND se1.E1_SALDO > 0
        AND RTRIM(se1.E1_TIPO) IN ('NF','NFS','BOL','DUP')
        -- Portador JA preenchido com banco comercial (financeiro ja decidiu pra qual banco)
        AND RTRIM(se1.E1_PORTADO) IN (${bancosIn})
        -- Sem bordero ainda (ainda nao foi pro CNAB)
        AND (se1.E1_NUMBOR IS NULL OR RTRIM(se1.E1_NUMBOR) = '')
        ${conds.join(' ')}
      ORDER BY se1.E1_VENCREA ASC, se1.E1_NUM
    `;

    try {
      const rows = await Protheus.connectAndQuery(sql, params);
      const titulos = rows.map(r => ({
        prefixo: trim(r.prefixo),
        numero: trim(r.numero),
        parcela: trim(r.parcela),
        tipo: trim(r.tipo),
        clienteCod: trim(r.clienteCod),
        clienteLoja: trim(r.clienteLoja),
        clienteNome: trim(r.clienteNome),
        clienteCnpj: trim(r.clienteCnpj),
        clienteEmail: trim(r.clienteEmail),
        clienteDdd: trim(r.clienteDdd),
        clienteTel: trim(r.clienteTel),
        clienteUf: trim(r.clienteUf),
        emissao: trim(r.emissao),
        vencimento: trim(r.vencimento),
        valor: toN(r.valor),
        saldo: toN(r.saldo),
        portador: trim(r.portador),
        formaPgto: trim(r.formaPgto),
        formaPgtoNome: FORMAS_NOMES[trim(r.formaPgto)] || trim(r.formaPgto),
        bordero: trim(r.bordero)
      }));
      const totalSaldo = titulos.reduce((s, t) => s + t.saldo, 0);
      return res.json({
        titulos,
        total: titulos.length,
        totalSaldo: Number(totalSaldo.toFixed(2)),
        truncado: titulos.length === limit,
        formas_pgto_aceitas: FORMAS_BOLETO_DEFAULT.map(c => ({ cod: c, nome: FORMAS_NOMES[c] }))
      });
    } catch (err) {
      console.error('boleto-elegiveis:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// GET /financeiro/boleto-elegiveis — titulos do SE1 SEM portador, prontos pra
// serem enviados a um banco escolhido pelo operador.
//
// REGRA (Mai/2026 — atualizada): mostra APENAS titulos SEM portador definido
// no Protheus (E1_PORTADO vazio/NULL). O fluxo eh:
//   1. Operador lista os titulos sem portador
//   2. Seleciona quantidade + banco pra qual enviar
//   3. Intranet chama Protheus pra gerar arquivo (ja temos integracao via
//      services/protheusCobranca.js + endpoint /financeiro/boleto-lote/:id/enviar-protheus)
//   4. Operador envia arquivo ao banco e aguarda retorno
//   5. (futuro) Le retorno + dispara boleto via WhatsApp/email
//
// Filtros via query: busca, dataIni/dataFim (vencimento), valorMin,
//   formaPgto (E1_FORMAPG, aceita lista CSV), emissaoIni/emissaoFim.
// Nao tem mais filtro por banco (todos os titulos aqui estao sem portador).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

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
    // Emissao
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
    // Filtro por tipo (E1_TIPO) — aceita CSV ("NF,DP") ou unico
    const tiposInput = trim(req.query.tipo);
    if (tiposInput) {
      const tiposLista = tiposInput.split(',').map(s => trim(s)).filter(Boolean);
      if (tiposLista.length > 0) {
        const tipoIn = tiposLista.map((_, i) => `@tp${i}`).join(',');
        tiposLista.forEach((t, i) => { params[`tp${i}`] = t; });
        conds.push(`AND RTRIM(se1.E1_TIPO) IN (${tipoIn})`);
      }
    }

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
        -- Exclui apenas adiantamento (RA) e nota credito cliente (NCC) — sao
        -- "creditos do cliente" e nao titulos cobraveis. Antes filtravamos
        -- whitelist (NF, NFS, BOL, DUP) e o tipo DP (duplicata provisoria)
        -- ficava de fora. Mesma regra do modulo Cobranca.
        AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
        -- SO titulos SEM portador definido — operador escolhe o banco no envio
        AND (se1.E1_PORTADO IS NULL OR RTRIM(se1.E1_PORTADO) = '')
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
      // Tipos distintos no resultado pra popular o dropdown do frontend
      const tiposCount = new Map();
      titulos.forEach(t => {
        const k = t.tipo || '—';
        tiposCount.set(k, (tiposCount.get(k) || 0) + 1);
      });
      const tipos_disponiveis = [...tiposCount.entries()]
        .map(([cod, qtd]) => ({ cod, qtd }))
        .sort((a, b) => b.qtd - a.qtd);

      return res.json({
        titulos,
        total: titulos.length,
        totalSaldo: Number(totalSaldo.toFixed(2)),
        truncado: titulos.length === limit,
        formas_pgto_aceitas: FORMAS_BOLETO_DEFAULT.map(c => ({ cod: c, nome: FORMAS_NOMES[c] })),
        tipos_disponiveis
      });
    } catch (err) {
      console.error('boleto-elegiveis:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// Painel de cobrança: títulos em atraso (D+N) agregados por cliente.
// Exclui E1_TIPO IN ('RA','NCC') — adiantamentos e créditos do cliente
// não são títulos a cobrar.
const trim = (v) => String(v || '').trim();
const toNumber = (v) => Number(v || 0);

// E1_FORMAPG não tem cBox nem mapeamento em SX5. Mapping abaixo é a
// interpretação mais comum no Protheus + cruzamento com tipo do título.
// Ajustar caso a TI/Financeiro confirme outras descrições.
const FORMAS_PGTO = {
  '1': 'Cheque',
  '2': 'Dinheiro',
  '3': 'Cartão',
  '4': 'Boleto Bancário',
  '5': 'Não informado',
  '6': 'Financiamento',
  '7': 'Cartão BNDS',
  '8': 'Bonificação',
  '9': 'Consignado',
  'B': 'Antecipação Parcelada',
  'A': 'Futuro Garantido',
  '': 'Não informado'
};
const descreverFormaPgto = (cod) => FORMAS_PGTO[cod] || `Forma ${cod}`;

const faixaAtraso = (dias) => {
  if (dias <= 15) return { codigo: 'A_6_15', label: '6-15 dias', cor: '#f5a500' };
  if (dias <= 30) return { codigo: 'A_16_30', label: '16-30 dias', cor: '#e55a1a' };
  if (dias <= 60) return { codigo: 'A_31_60', label: '31-60 dias', cor: '#c9302c' };
  if (dias <= 90) return { codigo: 'A_61_90', label: '61-90 dias', cor: '#8a1f1b' };
  return { codigo: 'A_90_MAIS', label: '90+ dias', cor: '#4a0e0e' };
};

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002, 9003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/painel',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;
    const { cliente, uf, faixa, bu, formaPgto } = req.query;
    const diasMinimos = Number(req.query.diasMinimos || 5);

    const params = { diasMinimos };
    const conds = [];
    if (cliente) {
      params.cliente = String(cliente).toUpperCase();
      conds.push(`AND (UPPER(sa1.A1_NOME) LIKE '%' + @cliente + '%' OR RTRIM(se1.E1_CLIENTE) = @cliente OR UPPER(RTRIM(se1.E1_NOMCLI)) LIKE '%' + @cliente + '%')`);
    }
    if (uf) {
      params.uf = String(uf).toUpperCase();
      conds.push(`AND RTRIM(sa1.A1_EST) = @uf`);
    }
    if (bu) {
      params.bu = String(bu).toUpperCase();
      conds.push(`AND RTRIM(sc5.C5_ZTIPO) = @bu`);
    }
    if (formaPgto) {
      params.formaPgto = String(formaPgto);
      conds.push(`AND RTRIM(se1.E1_FORMAPG) = @formaPgto`);
    }

    const sql = `
      SELECT
        RTRIM(se1.E1_PREFIXO) AS prefixo,
        RTRIM(se1.E1_NUM)     AS numero,
        RTRIM(se1.E1_PARCELA) AS parcela,
        RTRIM(se1.E1_TIPO)    AS tipo,
        RTRIM(se1.E1_CLIENTE) AS clienteCod,
        RTRIM(se1.E1_LOJA)    AS clienteLoja,
        RTRIM(COALESCE(NULLIF(sa1.A1_NOME, ''), se1.E1_NOMCLI)) AS clienteNome,
        RTRIM(sa1.A1_MUN)     AS clienteMunicipio,
        RTRIM(sa1.A1_EST)     AS clienteEstado,
        RTRIM(sa1.A1_CGC)     AS clienteCgc,
        RTRIM(sa1.A1_END)     AS clienteEndereco,
        RTRIM(sa1.A1_BAIRRO)  AS clienteBairro,
        RTRIM(sa1.A1_CEP)     AS clienteCep,
        RTRIM(sa1.A1_EMAIL)   AS clienteEmail,
        RTRIM(sa1.A1_DDD)     AS clienteDDD,
        RTRIM(sa1.A1_TEL)     AS clienteTel,
        RTRIM(sa1.A1_VEND)    AS vendedor,
        RTRIM(sa3.A3_NOME)    AS vendedorNome,
        se1.E1_EMISSAO        AS emissao,
        se1.E1_VENCTO         AS vencimento,
        se1.E1_VENCREA        AS vencimentoReal,
        se1.E1_VALOR          AS valor,
        se1.E1_SALDO          AS saldo,
        RTRIM(se1.E1_NATUREZ) AS natureza,
        RTRIM(se1.E1_HIST)    AS historico,
        RTRIM(se1.E1_PEDIDO)  AS pedido,
        RTRIM(se1.E1_FORMAPG) AS formaPgto,
        RTRIM(sc5.C5_ZTIPO)   AS buCod,
        RTRIM(buNome.X5_DESCRI) AS buNome,
        DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) AS diasAtraso
      FROM SE1010 se1 WITH (NOLOCK)
      LEFT JOIN SA1010 sa1 WITH (NOLOCK)
        ON sa1.A1_COD  = se1.E1_CLIENTE
       AND sa1.A1_LOJA = se1.E1_LOJA
       AND sa1.D_E_L_E_T_ <> '*'
      LEFT JOIN SA3010 sa3 WITH (NOLOCK)
        ON sa3.A3_COD = sa1.A1_VEND AND sa3.D_E_L_E_T_ <> '*'
      LEFT JOIN SC5010 sc5 WITH (NOLOCK)
        ON sc5.C5_FILIAL = se1.E1_FILIAL
       AND sc5.C5_NUM    = se1.E1_PEDIDO
       AND sc5.D_E_L_E_T_ <> '*'
      LEFT JOIN SX5010 buNome WITH (NOLOCK)
        ON RTRIM(buNome.X5_TABELA) = 'Z1'
       AND RTRIM(buNome.X5_CHAVE)  = RTRIM(sc5.C5_ZTIPO)
       AND buNome.D_E_L_E_T_ <> '*'
      WHERE se1.D_E_L_E_T_ <> '*'
        AND se1.E1_SALDO > 0
        -- E1_BAIXA pode estar preenchida em baixas parciais. O criterio canonico
        -- de "titulo em aberto" no Protheus eh apenas E1_SALDO > 0 (sem checar
        -- E1_BAIXA), senao ~96 clientes / R$660k de saldo residual ficam de fora.
        AND RTRIM(se1.E1_TIPO) NOT IN ('RA', 'NCC')
        AND DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) >= @diasMinimos
        ${conds.join(' ')}
      ORDER BY DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) DESC
    `;

    try {
      const rows = await Protheus.connectAndQuery(sql, params);

      const titulos = rows.map((r) => {
        const dias = toNumber(r.diasAtraso);
        return {
          prefixo: trim(r.prefixo),
          numero: trim(r.numero),
          parcela: trim(r.parcela),
          tipo: trim(r.tipo),
          clienteCod: trim(r.clienteCod),
          clienteLoja: trim(r.clienteLoja),
          clienteNome: trim(r.clienteNome),
          clienteMunicipio: trim(r.clienteMunicipio),
          clienteEstado: trim(r.clienteEstado),
          clienteCgc: trim(r.clienteCgc),
          clienteEndereco: trim(r.clienteEndereco),
          clienteBairro: trim(r.clienteBairro),
          clienteCep: trim(r.clienteCep),
          clienteEmail: trim(r.clienteEmail),
          clienteDDD: trim(r.clienteDDD),
          clienteTel: trim(r.clienteTel),
          vendedor: trim(r.vendedor),
          vendedorNome: trim(r.vendedorNome),
          emissao: trim(r.emissao),
          vencimento: trim(r.vencimento),
          vencimentoReal: trim(r.vencimentoReal),
          valor: toNumber(r.valor),
          saldo: toNumber(r.saldo),
          natureza: trim(r.natureza),
          historico: trim(r.historico),
          pedido: trim(r.pedido),
          formaPgto: trim(r.formaPgto),
          formaPgtoNome: descreverFormaPgto(trim(r.formaPgto)),
          buCod: trim(r.buCod),
          buNome: trim(r.buNome) || trim(r.buCod) || '(sem BU)',
          diasAtraso: dias,
          faixa: faixaAtraso(dias)
        };
      });

      const filtrados = faixa
        ? titulos.filter(t => t.faixa.codigo === String(faixa))
        : titulos;

      // Pega status e última ação de cada cliente que apareceu (Intranet DB)
      const clienteKeys = [...new Set(filtrados.map(t => `${t.clienteCod}|${t.clienteLoja}`))];
      let statusMap = new Map();
      let ultimaAcaoMap = new Map();
      if (clienteKeys.length > 0) {
        try {
          const statusRows = await Pg.connectAndQuery(
            `SELECT CLIENTE_COD, CLIENTE_LOJA, STATUS, OBSERVACAO, DT_ATUALIZACAO
               FROM tab_cobranca_status_cliente`,
            {}
          );
          statusRows.forEach(s => statusMap.set(`${trim(s.CLIENTE_COD)}|${trim(s.CLIENTE_LOJA)}`, {
            status: trim(s.STATUS), observacao: s.OBSERVACAO, dt: s.DT_ATUALIZACAO
          }));

          const acoesRows = await Pg.connectAndQuery(
            `SELECT CLIENTE_COD, CLIENTE_LOJA, TIPO_ACAO, RESULTADO, DATA_PROMESSA, VALOR_PROMETIDO, CRIADO_EM,
                    ROW_NUMBER() OVER (PARTITION BY CLIENTE_COD, CLIENTE_LOJA ORDER BY CRIADO_EM DESC) rn
               FROM tab_cobranca_acao`,
            {}
          );
          acoesRows.filter(a => a.rn === 1).forEach(a => ultimaAcaoMap.set(`${trim(a.CLIENTE_COD)}|${trim(a.CLIENTE_LOJA)}`, {
            tipoAcao: trim(a.TIPO_ACAO),
            resultado: trim(a.RESULTADO),
            dataPromessa: a.DATA_PROMESSA,
            valorPrometido: a.VALOR_PROMETIDO,
            criadoEm: a.CRIADO_EM
          }));
        } catch (e) {
          console.warn('Cobrança painel: falha ao carregar status/ações — seguindo sem enriquecer.', e.message);
        }
      }

      // Anexa o status de cobrança (cadastrado pelo operador em
      // tab_cobranca_status_cliente) a cada título, pra que o export por título
      // também traga essa informação.
      filtrados.forEach(t => {
        const st = statusMap.get(`${t.clienteCod}|${t.clienteLoja}`);
        t.statusCobranca = st ? st.status : '';
      });

      // Agrega por cliente
      const porClienteMap = new Map();
      filtrados.forEach(t => {
        const key = `${t.clienteCod}|${t.clienteLoja}`;
        if (!porClienteMap.has(key)) {
          porClienteMap.set(key, {
            clienteCod: t.clienteCod,
            clienteLoja: t.clienteLoja,
            clienteNome: t.clienteNome,
            clienteCgc: t.clienteCgc,
            clienteMunicipio: t.clienteMunicipio,
            clienteEstado: t.clienteEstado,
            clienteEmail: t.clienteEmail,
            clienteDDD: t.clienteDDD,
            clienteTel: t.clienteTel,
            vendedorNome: t.vendedorNome,
            totalSaldo: 0,
            qtdTitulos: 0,
            maiorAtraso: 0,
            titulos: [],
            statusCobranca: statusMap.get(key) || null,
            ultimaAcao: ultimaAcaoMap.get(key) || null
          });
        }
        const agg = porClienteMap.get(key);
        agg.totalSaldo += t.saldo;
        agg.qtdTitulos += 1;
        if (t.diasAtraso > agg.maiorAtraso) agg.maiorAtraso = t.diasAtraso;
        agg.titulos.push({ numero: t.numero, parcela: t.parcela, saldo: t.saldo, diasAtraso: t.diasAtraso, vencimento: t.vencimento });
      });
      const porCliente = Array.from(porClienteMap.values())
        .sort((a, b) => b.totalSaldo - a.totalSaldo);

      // KPIs
      const totalGeral = filtrados.reduce((s, t) => s + t.saldo, 0);
      const qtdClientes = porCliente.length;
      const porFaixa = {};
      filtrados.forEach(t => {
        const f = t.faixa.codigo;
        if (!porFaixa[f]) porFaixa[f] = { label: t.faixa.label, cor: t.faixa.cor, qtd: 0, valor: 0 };
        porFaixa[f].qtd += 1;
        porFaixa[f].valor += t.saldo;
      });

      // Listas distintas para popular os filtros de BU e Forma de Pgto.
      // Usamos `titulos` (sem aplicar `bu`/`formaPgto` no SQL) para que o
      // usuário sempre veja as opções disponíveis no universo carregado.
      const busSet = new Map();      // cod -> nome
      const formasSet = new Map();   // cod -> qtd
      titulos.forEach(t => {
        if (t.buCod) busSet.set(t.buCod, t.buNome || t.buCod);
        if (t.formaPgto) formasSet.set(t.formaPgto, (formasSet.get(t.formaPgto) || 0) + 1);
      });
      const busDisponiveis = [...busSet.entries()]
        .map(([cod, nome]) => ({ cod, nome }))
        .sort((a, b) => a.nome.localeCompare(b.nome));
      const formasPgtoDisponiveis = [...formasSet.entries()]
        .map(([cod, qtd]) => ({ cod, nome: descreverFormaPgto(cod), qtd }))
        .sort((a, b) => a.nome.localeCompare(b.nome));

      return res.json({
        diasMinimos,
        totalRegistros: filtrados.length,
        qtdClientes,
        totalGeral,
        porFaixa,
        busDisponiveis,
        formasPgtoDisponiveis,
        geradoEm: new Date().toISOString(),
        titulos: filtrados,
        porCliente
      });
    } catch (error) {
      console.error('Erro em cobranca/painel:', error);
      return res.status(500).json({ message: 'Erro ao consultar cobrança.' });
    }
  }
});

// Notas fiscais a expedir: SF2010 ainda não expedidas (z1_expedic IS NULL),
// filial 01, série 1, emissão após 2020-03-01, exclui CFOPs que não entram
// na expedição física (5118/6118/5119/6119/5934/5905/5922/6922).
// Enriquece com flag `noBordero` consultando tab_exp_bordero da Intranet.
//
// CATEGORIZAÇÃO DO DIFAL (campo `difalCategoria`):
//   - 'SEM_DIFAL'        : difal == 0
//   - 'ST_MENSAL'        : difal > 0 E UF do destinatário tem IE Gnatus → apuração
//                          mensal por substituição tributária (Clara não paga diário)
//   - 'INDEVIDO_CONTRIB' : difal > 0 E cliente é CONTRIBUINTE (A1_CONTRIB != '2') →
//                          provável erro de cadastro/TES no Protheus (DIFAL EC 87/2015
//                          é só pra não contribuinte) — auditar no caso a caso
//   - 'DIARIO'           : difal > 0 E não contribuinte E UF sem IE Gnatus → DIFAL real
//                          que a Clara precisa pagar/recolher diariamente
//
// O contador "Só com DIFAL" do frontend agora considera só DIARIO.

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

// UFs onde a Gnatus tem IE como Substituto Tributário — DIFAL é apurado
// mensalmente, não NF a NF. Lista informada pelo financeiro em 2026-05-27.
// Se mudar, atualizar aqui e fazer deploy (não há tabela de config ainda).
const UFS_IE_GNATUS = new Set(['AM', 'CE', 'DF', 'PR', 'MA', 'MG', 'RJ', 'SC']);

const classificarDifal = (difal, uf, contrib) => {
  if (!(Number(difal) > 0)) return 'SEM_DIFAL';
  if (UFS_IE_GNATUS.has(trim(uf).toUpperCase())) return 'ST_MENSAL';
  // A1_CONTRIB: '1' = contribuinte, '2' = não contribuinte, '9' = isento.
  // DIFAL EC 87/2015 / LC 190/2022: só destinatário NÃO contribuinte (= '2').
  if (trim(contrib) !== '2') return 'INDEVIDO_CONTRIB';
  return 'DIARIO';
};

module.exports = (app) => ({
  verb: 'get',
  route: '/notas',
  // Perm 12001 (mesma da tela) — estava sem requirePerm: qualquer logado listava
  // todas as NFs com dados de cliente via API (verificado 21/08 no diagnóstico
  // do "0 resultados"; a tela sempre exigiu 12001).
  middlewares: [require('../../middlewares/requirePerm')(app)([12001])],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;

    // Default de 6 anos atrás era uma armadilha: qualquer chamada sem
    // dataMinima varria a base inteira (a aba "expedidas" sem data devolve
    // ~57 mil notas / ~24 MB de JSON). O default passa a ser o dia 1º do mês
    // anterior — a mesma janela que a tela abre.
    const dataMinima = trim(req.query.dataMinima) || (() => {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - 1);
      return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`;
    })();

    const busca = trim(req.query.busca).toUpperCase();
    // Só os dígitos do termo — usado na comparação de CNPJ, que no cadastro
    // vem sem máscara.
    const buscaNum = busca.replace(/\D/g, '');

    // Rede de segurança contra a consulta que volta gigante. Não é paginação:
    // a tela soma volumes, valor e DIFAL sobre a lista inteira, então cortar
    // silenciosamente deixaria os totalizadores errados. Aqui o corte é alto,
    // só para a tela nunca receber 24 MB, e vem sinalizado para o usuário
    // saber que precisa estreitar o filtro.
    const LIMITE_PADRAO = 2000;
    const LIMITE_MAX = 5000;
    const limite = Math.min(
      LIMITE_MAX,
      Math.max(1, Number(req.query.limite) || LIMITE_PADRAO)
    );
    // 3 abas:
    //   pendentes     -> sem expedicao registrada (default, comportamento legado)
    //   sem_rastreio  -> expedida mas sem numero de rastreio
    //   expedidas     -> expedida + com rastreio
    const ABAS_VALIDAS = new Set(['pendentes', 'sem_rastreio', 'expedidas']);
    const aba = ABAS_VALIDAS.has(req.query.aba) ? req.query.aba : 'pendentes';

    const params = { dataMinima, limite };
    const conds = [];

    // Quando o termo pode ser um pedido de venda, resolve pedido -> NFs numa
    // consulta própria e leve, ANTES da principal. Um EXISTS correlacionado
    // sobre a SD2 aqui dentro custava ~1s; o par de consultas fica em ~260ms,
    // porque o lookup roda uma vez em vez de por linha candidata.
    let docsDoPedido = [];
    if (busca && /^\d+$/.test(busca) && buscaNum.length <= 6) {
      try {
        const achados = await Protheus.connectAndQuery(`
          SELECT DISTINCT RTRIM(D2_DOC) doc
            FROM SD2010 WITH (NOLOCK)
           WHERE D_E_L_E_T_ <> '*' AND D2_FILIAL = '01'
             AND RTRIM(D2_PEDIDO) = @ped`,
          { ped: buscaNum.padStart(6, '0') });
        docsDoPedido = (achados || []).map(r => trim(r.doc)).filter(Boolean).slice(0, 200);
      } catch (e) {
        // Busca por pedido é um extra: se falhar, a busca por NF/cliente/nome
        // continua valendo em vez de derrubar a tela inteira.
        console.warn('Expedição/notas: lookup de pedido falhou —', e.message);
      }
    }

    if (busca) {
      params.busca = busca;
      const alvos = [];

      // Termo só de dígitos = NF, pedido ou código de cliente. Os três campos
      // são char(6) com zero à esquerda ('091548'), e o operador digita sem
      // ('91548') — o LIKE de prefixo que existia aqui não achava nada, e era
      // a causa das "notas que não retornam".
      //
      // A comparação é EXATA sobre o termo preenchido de zeros, não "contém":
      // contém traria a nota certa junto de um punhado de falsos positivos
      // (o número aparecendo no meio de um CNPJ, de outro pedido) e ainda
      // obrigaria a varrer a SD2 inteira com LIKE '%...%'.
      const soDigitos = /^\d+$/.test(busca);
      if (soDigitos && buscaNum.length <= 6) {
        params.cod6 = buscaNum.padStart(6, '0');
        // Sem RTRIM na coluna: o '=' do SQL Server já ignora espaço à direita,
        // e a função em volta do campo derrubava o índice (177ms -> 33ms).
        alvos.push(`f2.F2_DOC = @cod6`);
        alvos.push(`f2.F2_CLIENTE = @cod6`);

        // NFs que vieram do pedido resolvido acima.
        if (docsDoPedido.length) {
          const marcas = docsDoPedido.map((d, i) => {
            params[`pd${i}`] = d;
            return `@pd${i}`;
          });
          alvos.push(`RTRIM(f2.F2_DOC) IN (${marcas.join(',')})`);
        }
      }

      // CPF/CNPJ: só a partir de 11 dígitos. Abaixo disso o "contém" casaria
      // com o pedaço de qualquer documento e poluiria o resultado.
      if (buscaNum.length >= 11) {
        params.buscaNum = buscaNum;
        alvos.push(`RTRIM(sa1.A1_CGC) LIKE '%' + @buscaNum + '%'`);
      }

      // Texto: nome do cliente e da transportadora.
      if (!soDigitos) {
        alvos.push(`UPPER(sa1.A1_NOME) LIKE '%' + @busca + '%'`);
        alvos.push(`UPPER(RTRIM(sa4.A4_NOME)) LIKE '%' + @busca + '%'`);
      }

      // Nada reconhecido (ex.: só símbolos) — não filtra por nada em vez de
      // devolver a base toda.
      conds.push(alvos.length ? `AND (${alvos.join(' OR ')})` : `AND 1 = 0`);
    }

    // Procurando por um termo, a data deixa de limitar: quem digita o número
    // da nota quer achar a nota, não descobrir que ela é anterior ao período
    // aberto na tela. Era o segundo motivo de "não retorna dados".
    const periodoIgnorado = !!busca;

    // Filtro principal por aba
    let condAba;
    if (aba === 'sem_rastreio') {
      condAba = `AND fe.z1_expedic IS NOT NULL AND (fe.z1_rastrei IS NULL OR RTRIM(fe.z1_rastrei) = '')`;
    } else if (aba === 'expedidas') {
      condAba = `AND fe.z1_expedic IS NOT NULL AND fe.z1_rastrei IS NOT NULL AND RTRIM(fe.z1_rastrei) <> ''`;
    } else {
      condAba = `AND fe.z1_expedic IS NULL`;
    }

    // Eixo da data "a partir de" muda por aba:
    //   pendentes                 -> EMISSAO da NF (ainda nao foi expedida)
    //   sem_rastreio / expedidas  -> data de EXPEDICAO (fluxo de quem expede)
    const dateCond = periodoIgnorado
      ? ''
      : (aba === 'pendentes')
        ? `AND f2.F2_EMISSAO >= @dataMinima`
        : `AND fe.z1_expedic >= @dataMinima`;

    // SX3 da Gnatus: DIFAL = SD2.D2_DIFAL ; FCP Proprio = SD2.D2_VALFECP.
    // Nao ha campo agregado em SF2 — somamos por NF via subquery.
    const sql = `
      SELECT TOP (@limite)
        RTRIM(f2.F2_DOC)     nfe,
        RTRIM(f2.F2_SERIE)   serie,
        f2.F2_EMISSAO        emissao,
        RTRIM(f2.F2_CLIENTE) clienteCod,
        RTRIM(f2.F2_LOJA)    clienteLoja,
        RTRIM(sa1.A1_NOME)   clienteNome,
        RTRIM(sa1.A1_CGC)    clienteCnpj,
        RTRIM(sa1.A1_END)    clienteEnd,
        RTRIM(sa1.A1_BAIRRO) clienteBairro,
        RTRIM(sa1.A1_MUN)    clienteMun,
        RTRIM(sa1.A1_EST)    clienteUf,
        RTRIM(sa1.A1_CEP)    clienteCep,
        RTRIM(sa1.A1_EMAIL)  clienteEmail,
        RTRIM(sa1.A1_CONTRIB) clienteContrib,
        RTRIM(sa1.A1_INSCR)   clienteInscr,
        f2.F2_VOLUME1        volumes,
        RTRIM(f2.F2_TRANSP)  transpCod,
        RTRIM(sa4.A4_NOME)   transpNome,
        fe.z1_expedic        zExpedic,
        RTRIM(fe.z1_rastrei) zRastrei,
        f2.F2_VALMERC        total,
        f2.R_E_C_N_O_        id
      FROM SF2010 f2 WITH (NOLOCK)
      LEFT JOIN SA1010 sa1 WITH (NOLOCK)
        ON f2.F2_CLIENTE = sa1.A1_COD AND f2.F2_LOJA = sa1.A1_LOJA
       AND sa1.D_E_L_E_T_ <> '*'
      LEFT JOIN faturamento_expedicao fe
        ON fe.z1_filial = f2.F2_FILIAL
       AND fe.z1_doc    = f2.F2_DOC
       AND fe.z1_serie  = f2.F2_SERIE
      LEFT JOIN SA4010 sa4 WITH (NOLOCK)
        ON f2.F2_TRANSP = sa4.A4_COD AND sa4.D_E_L_E_T_ <> '*'
      WHERE f2.F2_FILIAL = '01'
        AND f2.D_E_L_E_T_ <> '*'
        AND f2.F2_SERIE = '1'
        ${dateCond}
        ${condAba}
        AND (sa1.A1_COD IS NULL OR sa1.D_E_L_E_T_ <> '*')
        -- Exclui NF que NAO tenha NENHUM item com CFOP de expedicao fisica.
        -- Antes era LEFT JOIN faturamento_cfop, mas a view agrupa por CFOP
        -- e a NF aparecia N vezes quando tinha mais de um CFOP (ex 6105+6106).
        -- EXISTS retorna 0/1 sem multiplicar linhas.
        AND EXISTS (
          SELECT 1 FROM faturamento_cfop fc
           WHERE fc.d2_filial = f2.F2_FILIAL
             AND fc.d2_doc    = f2.F2_DOC
             AND fc.d2_serie  = f2.F2_SERIE
             AND fc.d2_cf NOT IN ('5118','6118','5119','6119','5934','5905','5922','6922')
        )
        ${conds.join(' ')}
      ORDER BY f2.F2_EMISSAO DESC, f2.F2_DOC DESC
    `;

    // Mesmos filtros da lista, sem as colunas caras (impostos e a subquery de
    // pedido). Só roda quando a lista bate no teto.
    const sqlContagem = `
      SELECT COUNT(*) total
        FROM SF2010 f2 WITH (NOLOCK)
        LEFT JOIN SA1010 sa1 WITH (NOLOCK)
          ON f2.F2_CLIENTE = sa1.A1_COD AND f2.F2_LOJA = sa1.A1_LOJA
         AND sa1.D_E_L_E_T_ <> '*'
        LEFT JOIN faturamento_expedicao fe
          ON fe.z1_filial = f2.F2_FILIAL AND fe.z1_doc = f2.F2_DOC AND fe.z1_serie = f2.F2_SERIE
        LEFT JOIN SA4010 sa4 WITH (NOLOCK)
          ON f2.F2_TRANSP = sa4.A4_COD AND sa4.D_E_L_E_T_ <> '*'
       WHERE f2.F2_FILIAL = '01'
         AND f2.D_E_L_E_T_ <> '*'
         AND f2.F2_SERIE = '1'
         ${dateCond}
         ${condAba}
         AND (sa1.A1_COD IS NULL OR sa1.D_E_L_E_T_ <> '*')
         AND EXISTS (
           SELECT 1 FROM faturamento_cfop fc
            WHERE fc.d2_filial = f2.F2_FILIAL AND fc.d2_doc = f2.F2_DOC
              AND fc.d2_serie = f2.F2_SERIE
              AND fc.d2_cf NOT IN ('5118','6118','5119','6119','5934','5905','5922','6922')
         )
         ${conds.join(' ')}
    `;

    try {
      const rows = await Protheus.connectAndQuery(sql, params);

      // ------------------------------------------------------------------
      // Enriquecimento em LOTE (impostos e pedido de venda).
      //
      // Antes isto vinha junto da consulta principal: um LEFT JOIN com
      // GROUP BY sobre a SD2 INTEIRA (347 mil linhas) mais um STUFF/FOR XML
      // correlacionado por linha. Na aba "pendentes" (~140 notas) passava
      // despercebido; na aba "expedidas" a mesma consulta levava 29,7s.
      //
      // Agora a principal traz só as notas, e o cálculo sai em duas varreduras
      // de uma FATIA da SD2 — limitada pela menor emissão que voltou, então
      // nenhum item fica de fora.
      // ------------------------------------------------------------------
      const chave = (r) => `${trim(r.nfe)}|${trim(r.serie)}|${trim(r.clienteCod)}|${trim(r.clienteLoja)}`;
      const impostos = new Map();
      const pedidos = new Map();

      if (rows.length) {
        const minEmissao = rows.reduce(
          (min, r) => (trim(r.emissao) && trim(r.emissao) < min ? trim(r.emissao) : min),
          '99991231'
        );

        try {
          const agg = await Protheus.connectAndQuery(`
            SELECT RTRIM(D2_DOC) doc, RTRIM(D2_SERIE) serie,
                   RTRIM(D2_CLIENTE) cli, RTRIM(D2_LOJA) loja,
                   SUM(D2_DIFAL) difal, SUM(D2_VALFECP) fcp
              FROM SD2010 WITH (NOLOCK)
             WHERE D_E_L_E_T_ <> '*' AND D2_FILIAL = '01'
               AND D2_EMISSAO >= @desde
             GROUP BY D2_DOC, D2_SERIE, D2_CLIENTE, D2_LOJA`,
            { desde: minEmissao });
          agg.forEach(a => impostos.set(
            `${trim(a.doc)}|${trim(a.serie)}|${trim(a.cli)}|${trim(a.loja)}`,
            { difal: toN(a.difal), fcp: toN(a.fcp) }
          ));
        } catch (e) {
          // Sem impostos a tela ainda serve para expedir; o DIFAL fica zerado.
          console.warn('Expedição/notas: falha ao somar impostos —', e.message);
        }

        try {
          const peds = await Protheus.connectAndQuery(`
            SELECT DISTINCT RTRIM(D2_DOC) doc, RTRIM(D2_SERIE) serie,
                   RTRIM(D2_CLIENTE) cli, RTRIM(D2_LOJA) loja,
                   RTRIM(D2_PEDIDO) pedido
              FROM SD2010 WITH (NOLOCK)
             WHERE D_E_L_E_T_ <> '*' AND D2_FILIAL = '01'
               AND D2_EMISSAO >= @desde
               AND RTRIM(D2_PEDIDO) <> ''`,
            { desde: minEmissao });
          peds.forEach(pd => {
            const k = `${trim(pd.doc)}|${trim(pd.serie)}|${trim(pd.cli)}|${trim(pd.loja)}`;
            if (!pedidos.has(k)) pedidos.set(k, []);
            const lista = pedidos.get(k);
            const v = trim(pd.pedido);
            if (v && !lista.includes(v)) lista.push(v);
          });
        } catch (e) {
          console.warn('Expedição/notas: falha ao buscar pedidos —', e.message);
        }
      }

      // Coleta as NFs que já estão no bordero
      const nfsNoBordero = new Set();
      try {
        const borderoRows = await Pg.connectAndQuery(
          `SELECT DISTINCT NOTAFISCAL FROM tab_exp_bordero`, {}
        );
        borderoRows.forEach(r => nfsNoBordero.add(trim(r.NOTAFISCAL)));
      } catch (e) { console.warn('Expedição/notas: falha ao ler bordero', e.message); }

      const notas = rows.map(r => {
        const k = chave(r);
        const imp = impostos.get(k) || { difal: 0, fcp: 0 };
        const difal = imp.difal;
        const uf    = trim(r.clienteUf);
        const contrib = trim(r.clienteContrib);
        return {
          id: r.id,
          nfe: trim(r.nfe),
          serie: trim(r.serie),
          pedido: (pedidos.get(k) || []).join(', '),
          emissao: trim(r.emissao),
          clienteCod: trim(r.clienteCod),
          clienteLoja: trim(r.clienteLoja),
          clienteNome: trim(r.clienteNome),
          clienteCnpj: trim(r.clienteCnpj),
          clienteEnd: trim(r.clienteEnd),
          clienteBairro: trim(r.clienteBairro),
          clienteMun: trim(r.clienteMun),
          clienteUf: uf,
          clienteCep: trim(r.clienteCep),
          clienteEmail: trim(r.clienteEmail),
          clienteContrib: contrib,           // '1'=contrib, '2'=nao contrib, '9'=isento
          clienteInscr: trim(r.clienteInscr),
          volumes: toN(r.volumes),
          transpCod: trim(r.transpCod),
          transpNome: trim(r.transpNome),
          zExpedic: trim(r.zExpedic),
          zRastrei: trim(r.zRastrei),
          total: toN(r.total),
          difal,
          fcp: imp.fcp,
          difalCategoria: classificarDifal(difal, uf, contrib),
          noBordero: nfsNoBordero.has(trim(r.nfe))
        };
      });

      // A lista bateu no teto? Só então paga o COUNT, para descobrir o total
      // real e avisar quem está na tela. No uso normal (algumas centenas de
      // notas) esta consulta nem roda.
      const truncado = rows.length >= limite;
      let totalDisponivel = notas.length;
      if (truncado) {
        try {
          const c = await Protheus.connectAndQuery(
            sqlContagem, { ...params });
          totalDisponivel = toN(c[0]?.total) || notas.length;
        } catch (e) {
          console.warn('Expedição/notas: falha ao contar o total', e.message);
          totalDisponivel = null;   // desconhecido — a tela avisa mesmo assim
        }
      }

      return res.json({
        aba,
        totalRegistros: notas.length,
        totalNoBordero: notas.filter(n => n.noBordero).length,
        // Sinalizações para a tela ser honesta com quem está olhando:
        truncado,                 // a lista foi cortada no teto
        limite,                   // qual foi o teto
        totalDisponivel,          // quantas existem de verdade (null = não deu p/ contar)
        periodoIgnorado,          // a busca desconsiderou o filtro de data
        dataMinima,
        notas,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro expedicao/notas:', err);
      return res.status(500).json({ message: 'Erro ao consultar notas a expedir.' });
    }
  }
});

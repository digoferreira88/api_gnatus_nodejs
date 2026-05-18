// Valorização de estoque: saldo atual x custo médio (SB2.B2_CM1).
// Agrupa por armazém e tipo de produto; lista detalhe ordenado por valor.
const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/estoque',

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const { tipo, armazem, busca } = req.query;

    const params = {};
    const conds  = [];
    if (tipo)    { params.tipo    = String(tipo).toUpperCase();    conds.push(`AND RTRIM(sb1.B1_TIPO) = @tipo`); }
    if (armazem) { params.armazem = String(armazem).toUpperCase(); conds.push(`AND RTRIM(sb2.B2_LOCAL) = @armazem`); }
    if (busca) {
      params.busca = String(busca).toUpperCase();
      conds.push(`AND (UPPER(sb1.B1_DESC) LIKE '%' + @busca + '%' OR sb2.B2_COD LIKE @busca + '%')`);
    }

    try {
      const sql = `
        SELECT RTRIM(sb2.B2_COD)   produto,
               RTRIM(sb1.B1_DESC)  descricao,
               RTRIM(sb1.B1_TIPO)  tipo,
               RTRIM(sb1.B1_UM)    um,
               RTRIM(sb2.B2_LOCAL) armazem,
               RTRIM(nnr.NNR_DESCRI) armazemDesc,
               sb2.B2_QATU  qatu,
               sb2.B2_CM1   cm1,
               sb2.B2_VATU1 valor,
               sb2.B2_RESERVA reserva,
               sb2.B2_QEMP  empenho
          FROM SB2010 sb2 WITH (NOLOCK)
          LEFT JOIN SB1010 sb1 WITH (NOLOCK)
            ON sb1.B1_COD = sb2.B2_COD AND sb1.D_E_L_E_T_ <> '*'
          LEFT JOIN NNR010 nnr WITH (NOLOCK)
            ON nnr.NNR_CODIGO = sb2.B2_LOCAL AND nnr.D_E_L_E_T_ <> '*'
         WHERE sb2.D_E_L_E_T_ <> '*'
           AND sb2.B2_FILIAL = '01'
           AND sb2.B2_QATU > 0
           ${conds.join(' ')}
      `;
      const rows = await Protheus.connectAndQuery(sql, params);

      const itens = rows.map(r => {
        const qatu = toN(r.qatu);
        const reserva = toN(r.reserva);
        return {
          produto: trim(r.produto),
          descricao: trim(r.descricao),
          tipo: trim(r.tipo),
          um: trim(r.um),
          armazem: trim(r.armazem),
          armazemDesc: trim(r.armazemDesc),
          qatu,
          cm1: toN(r.cm1),
          valor: toN(r.valor),
          reserva,
          empenho: toN(r.empenho),
          disponivel: qatu - reserva
        };
      }).sort((a, b) => b.valor - a.valor);

      // Última nota de entrada por produto — busca em batches para evitar
      // estouro do limite de parâmetros do SQL Server (~2100). Mesma lógica
      // usada em controladoria/custo-produto.
      // Pulamos quando o universo é grande demais (sem filtro): a CTE com
      // ROW_NUMBER em SD1010 explode em runtime se forem milhares de produtos.
      // O frontend mostra "—" quando ultimaCompra=null e o usuário usa filtros
      // para ver o detalhe da NF.
      const codsUnicos = [...new Set(itens.map(i => i.produto))];
      const mapUlt = new Map();
      const LIMITE_ULTIMA = 1500;
      const buscarUltima = codsUnicos.length > 0 && codsUnicos.length <= LIMITE_ULTIMA;
      const BATCH = 500;
      for (let i = 0; buscarUltima && i < codsUnicos.length; i += BATCH) {
        const slice = codsUnicos.slice(i, i + BATCH);
        const inClause = slice.map((_, k) => `@c${k}`).join(',');
        const params = {};
        slice.forEach((c, k) => { params[`c${k}`] = c; });
        try {
          const ult = await Protheus.connectAndQuery(
            `WITH ranked AS (
              SELECT RTRIM(sd1.D1_COD)     componente,
                     RTRIM(sd1.D1_DOC)     doc,
                     RTRIM(sd1.D1_SERIE)   serie,
                     RTRIM(sd1.D1_FORNECE) fornece,
                     RTRIM(sd1.D1_LOJA)    loja,
                     RTRIM(sa2.A2_NOME)    fornecedor,
                     RTRIM(sa2.A2_NREDUZ)  fornecedorFantasia,
                     sf1.F1_EMISSAO        emissao,
                     sd1.D1_QUANT          qtdComprada,
                     sd1.D1_VUNIT          vunit,
                     sd1.D1_TOTAL          total,
                     sd1.D1_VALICM         icms,
                     sd1.D1_VALIPI         ipi,
                     sd1.D1_VALIMP5        pis,
                     sd1.D1_VALIMP6        cofins,
                     RTRIM(sd1.D1_CF)      cfop,
                     ROW_NUMBER() OVER (PARTITION BY sd1.D1_COD ORDER BY sf1.F1_EMISSAO DESC, sd1.R_E_C_N_O_ DESC) rn
                FROM SD1010 sd1 WITH (NOLOCK)
               INNER JOIN SF1010 sf1 WITH (NOLOCK)
                  ON sf1.F1_FILIAL  = sd1.D1_FILIAL
                 AND sf1.F1_DOC     = sd1.D1_DOC
                 AND sf1.F1_SERIE   = sd1.D1_SERIE
                 AND sf1.F1_FORNECE = sd1.D1_FORNECE
                 AND sf1.F1_LOJA    = sd1.D1_LOJA
                 AND sf1.D_E_L_E_T_ <> '*'
                 AND RTRIM(sf1.F1_TIPO) NOT IN ('D')
                LEFT JOIN SA2010 sa2 WITH (NOLOCK)
                  ON sa2.A2_COD  = sd1.D1_FORNECE
                 AND sa2.A2_LOJA = sd1.D1_LOJA
                 AND sa2.D_E_L_E_T_ <> '*'
               WHERE sd1.D_E_L_E_T_ <> '*'
                 AND sd1.D1_COD IN (${inClause})
                 AND sd1.D1_QUANT > 0
            )
            SELECT * FROM ranked WHERE rn = 1`,
            params
          );
          ult.forEach(u => mapUlt.set(trim(u.componente), {
            emissao: trim(u.emissao),
            nfDoc: trim(u.doc),
            nfSerie: trim(u.serie),
            fornecedorCod: trim(u.fornece),
            fornecedorLoja: trim(u.loja),
            fornecedor: trim(u.fornecedor),
            fornecedorFantasia: trim(u.fornecedorFantasia),
            qtdComprada: toN(u.qtdComprada),
            vunit: toN(u.vunit),
            totalItem: toN(u.total),
            icms: toN(u.icms),
            ipi: toN(u.ipi),
            pis: toN(u.pis),
            cofins: toN(u.cofins),
            cfop: trim(u.cfop)
          }));
        } catch (e) { console.warn('estoque: falha ao buscar ultima compra batch', i, e.message); }
      }

      // Atribui ultimaCompra a cada item (mesmo produto em armazéns diferentes
      // compartilha a mesma última compra)
      itens.forEach(i => { i.ultimaCompra = mapUlt.get(i.produto) || null; });

      // Agregações
      const porArmazem = new Map();
      const porTipo    = new Map();
      let totalValor = 0, totalQatu = 0;

      itens.forEach(i => {
        totalValor += i.valor;
        totalQatu  += i.qatu;
        const ka = i.armazem || '—';
        if (!porArmazem.has(ka)) porArmazem.set(ka, { armazem: ka, armazemDesc: i.armazemDesc, qtdProdutos: 0, qtdUnidades: 0, valor: 0 });
        const a = porArmazem.get(ka);
        a.qtdProdutos += 1;
        a.qtdUnidades += i.qatu;
        a.valor += i.valor;

        const kt = i.tipo || '—';
        if (!porTipo.has(kt)) porTipo.set(kt, { tipo: kt, qtdProdutos: 0, valor: 0 });
        const t = porTipo.get(kt);
        t.qtdProdutos += 1;
        t.valor += i.valor;
      });

      return res.json({
        totalValor, totalQatu, qtdRegistros: itens.length,
        porArmazem: Array.from(porArmazem.values()).sort((a,b) => b.valor - a.valor),
        porTipo:    Array.from(porTipo.values()).sort((a,b) => b.valor - a.valor),
        itens,
        ultimaCompraIncluida: buscarUltima,
        limiteUltimaCompra: LIMITE_ULTIMA,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro controladoria/estoque:', err);
      return res.status(500).json({ message: 'Erro ao consultar estoque.' });
    }
  }
});

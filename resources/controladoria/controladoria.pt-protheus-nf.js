// GET /controladoria/pt/protheus/nf?tipo=saida|entrada&nf=xxx&serie=yyy
// Busca uma NF no Protheus pra preencher o cadastro/finalizacao no Controle
// de Poder de Terceiros.
//
//   tipo=saida   → SF2010 + SD2010 (NF de saida emitida pela Gnatus)
//                  Usado em: cadastro de envio (NF Saida), finalizacao por VENDA/RENOVACAO
//   tipo=entrada → SF1010 + SD1010 (NF de entrada — devolucao do terceiro)
//                  Usado em: finalizacao por RETORNO/PARCIAL/TROCA
//
// Permissao 11003.

const trim = (v) => String(v || '').trim();
const toN = (v) => Number(v || 0);
const fmtIsoDate = (yyyymmdd) => {
  const s = trim(yyyymmdd);
  if (s.length !== 8) return null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
};

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([11003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/pt/protheus/nf',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;

    const tipo = String(req.query.tipo || 'saida').toLowerCase();
    const nf = trim(req.query.nf);
    const serie = trim(req.query.serie);
    const filial = trim(req.query.filial) || '01';

    if (!nf) return res.status(400).json({ message: 'Parametro nf obrigatorio.' });
    if (!['saida', 'entrada'].includes(tipo)) {
      return res.status(400).json({ message: 'tipo invalido (saida|entrada).' });
    }

    const params = { filial, nf };
    let condSerie = '';
    if (serie) { condSerie = ' AND F_SERIE = @serie'; params.serie = serie; }

    try {
      // Cabecalho
      const cabSql = tipo === 'saida'
        ? `SELECT TOP 1
             RTRIM(F2_FILIAL) filial, RTRIM(F2_DOC) nf, RTRIM(F2_SERIE) serie,
             F2_EMISSAO emissao, F2_VALBRUT valor_bruto, F2_VALMERC valor_merc,
             RTRIM(F2_CLIENTE) clifor_cod, RTRIM(F2_LOJA) clifor_loja,
             F2_TIPO tipo_doc, RTRIM(F2_ESPECIE) especie
           FROM SF2010 WITH (NOLOCK)
           WHERE D_E_L_E_T_ <> '*'
             AND F2_FILIAL = @filial
             AND RTRIM(F2_DOC) = @nf
             ${condSerie.replace('F_', 'F2_')}`
        : `SELECT TOP 1
             RTRIM(F1_FILIAL) filial, RTRIM(F1_DOC) nf, RTRIM(F1_SERIE) serie,
             F1_EMISSAO emissao, F1_VALBRUT valor_bruto, F1_VALMERC valor_merc,
             RTRIM(F1_FORNECE) clifor_cod, RTRIM(F1_LOJA) clifor_loja,
             F1_TIPO tipo_doc, RTRIM(F1_ESPECIE) especie
           FROM SF1010 WITH (NOLOCK)
           WHERE D_E_L_E_T_ <> '*'
             AND F1_FILIAL = @filial
             AND RTRIM(F1_DOC) = @nf
             ${condSerie.replace('F_', 'F1_')}`;

      const cabRows = await Protheus.connectAndQuery(cabSql, params);
      if (!cabRows.length) return res.status(404).json({ message: 'NF nao encontrada no Protheus.' });

      const cab = cabRows[0];

      // Itens (uniao por chave NF + serie + clifor + loja)
      const itensSql = tipo === 'saida'
        ? `SELECT RTRIM(D2_COD) produto,
                  D2_QUANT qtd, D2_PRCVEN prunit, D2_TOTAL total,
                  RTRIM(D2_CF) cfop, RTRIM(D2_TES) tes, RTRIM(D2_PEDIDO) pedido,
                  RTRIM(B1_DESC) descricao, RTRIM(D2_UM) um
             FROM SD2010 WITH (NOLOCK)
             LEFT JOIN SB1010 WITH (NOLOCK)
               ON SB1010.B1_COD = SD2010.D2_COD AND SB1010.D_E_L_E_T_ <> '*'
            WHERE SD2010.D_E_L_E_T_ <> '*'
              AND SD2010.D2_FILIAL = @filial
              AND RTRIM(SD2010.D2_DOC) = @nf
              AND RTRIM(SD2010.D2_SERIE) = @serie
              AND RTRIM(SD2010.D2_CLIENTE) = @clifor
              AND RTRIM(SD2010.D2_LOJA) = @loja`
        : `SELECT RTRIM(D1_COD) produto,
                  D1_QUANT qtd, D1_VUNIT prunit, D1_TOTAL total,
                  RTRIM(D1_CF) cfop, RTRIM(D1_TES) tes, RTRIM(D1_PEDIDO) pedido,
                  RTRIM(B1_DESC) descricao, RTRIM(D1_UM) um
             FROM SD1010 WITH (NOLOCK)
             LEFT JOIN SB1010 WITH (NOLOCK)
               ON SB1010.B1_COD = SD1010.D1_COD AND SB1010.D_E_L_E_T_ <> '*'
            WHERE SD1010.D_E_L_E_T_ <> '*'
              AND SD1010.D1_FILIAL = @filial
              AND RTRIM(SD1010.D1_DOC) = @nf
              AND RTRIM(SD1010.D1_SERIE) = @serie
              AND RTRIM(SD1010.D1_FORNECE) = @clifor
              AND RTRIM(SD1010.D1_LOJA) = @loja`;

      const itens = await Protheus.connectAndQuery(itensSql, {
        filial, nf, serie: trim(cab.serie),
        clifor: trim(cab.clifor_cod), loja: trim(cab.clifor_loja)
      });

      // Cliente/Fornecedor (SA1 pra saida; SA2 pra entrada)
      const sa = tipo === 'saida'
        ? await Protheus.connectAndQuery(
            `SELECT TOP 1 RTRIM(A1_COD) cod, RTRIM(A1_LOJA) loja, RTRIM(A1_NOME) nome,
                          RTRIM(A1_MUN) municipio, RTRIM(A1_EST) uf,
                          RTRIM(A1_DDD) ddd, RTRIM(A1_TEL) tel, RTRIM(A1_DDDCEL) dddcel
               FROM SA1010 WITH (NOLOCK)
              WHERE D_E_L_E_T_ <> '*'
                AND A1_COD = @cod AND A1_LOJA = @loja`,
            { cod: trim(cab.clifor_cod), loja: trim(cab.clifor_loja) }
          )
        : await Protheus.connectAndQuery(
            `SELECT TOP 1 RTRIM(A2_COD) cod, RTRIM(A2_LOJA) loja, RTRIM(A2_NOME) nome,
                          RTRIM(A2_MUN) municipio, RTRIM(A2_EST) uf
               FROM SA2010 WITH (NOLOCK)
              WHERE D_E_L_E_T_ <> '*'
                AND A2_COD = @cod AND A2_LOJA = @loja`,
            { cod: trim(cab.clifor_cod), loja: trim(cab.clifor_loja) }
          );

      // CFOP dominante (mais frequente entre os itens)
      const cfopCount = {};
      itens.forEach(i => {
        const c = trim(i.cfop);
        if (c) cfopCount[c] = (cfopCount[c] || 0) + 1;
      });
      const cfopDominante = Object.entries(cfopCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      // Pedido dominante (caso tenha 1 unico pedido em todos os itens)
      const pedidos = [...new Set(itens.map(i => trim(i.pedido)).filter(Boolean))];

      return res.json({
        encontrado: true,
        tipo,
        nf: {
          filial: trim(cab.filial),
          numero: trim(cab.nf),
          serie: trim(cab.serie),
          emissao: fmtIsoDate(cab.emissao),
          valor_bruto: toN(cab.valor_bruto),
          valor_mercadoria: toN(cab.valor_merc),
          tipo_doc: trim(cab.tipo_doc),
          especie: trim(cab.especie),
          cfop_dominante: cfopDominante,
          pedido: pedidos.length === 1 ? pedidos[0] : null,
          pedidos_distintos: pedidos
        },
        clifor: sa[0] ? {
          cod: trim(sa[0].cod),
          loja: trim(sa[0].loja),
          nome: trim(sa[0].nome),
          municipio: trim(sa[0].municipio),
          uf: trim(sa[0].uf),
          ddd: trim(sa[0].ddd),
          tel: trim(sa[0].tel),
          dddcel: trim(sa[0].dddcel)
        } : { cod: trim(cab.clifor_cod), loja: trim(cab.clifor_loja), nome: null },
        itens: itens.map(i => ({
          produto: trim(i.produto),
          descricao: trim(i.descricao),
          quantidade: toN(i.qtd),
          valor_unit: toN(i.prunit),
          valor_total: toN(i.total),
          cfop: trim(i.cfop),
          tes: trim(i.tes),
          pedido: trim(i.pedido),
          um: trim(i.um)
        }))
      });
    } catch (err) {
      console.error('pt-protheus-nf:', err);
      return res.status(500).json({ message: 'Erro ao consultar Protheus: ' + err.message });
    }
  }
});

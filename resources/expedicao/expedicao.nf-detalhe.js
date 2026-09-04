// GET /expedicao/notas/:doc/:serie — previa de NF de saida pra conferencia.
// Cabecalho (SF2) + cliente (SA1) + transportadora (SA4) + itens (SD2 + descricao via SB1) +
// totais consolidados de impostos.

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/notas/:doc/:serie',
  // Estava SEM checagem de permissão: qualquer usuário logado abria o detalhe
  // da NF com nome, CNPJ, endereço e e-mail do cliente. Mesma perm da tela.
  middlewares: [require('../../middlewares/requirePerm')(app)([12001])],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const doc   = trim(req.params.doc);
    const serie = trim(req.params.serie);
    if (!doc || !serie) return res.status(400).json({ message: 'doc e serie obrigatorios.' });

    try {
      const cab = await Protheus.connectAndQuery(
        `SELECT TOP 1
           RTRIM(f2.F2_DOC) doc, RTRIM(f2.F2_SERIE) serie, f2.F2_EMISSAO emissao,
           RTRIM(f2.F2_CLIENTE) clienteCod, RTRIM(f2.F2_LOJA) clienteLoja,
           RTRIM(sa1.A1_NOME) clienteNome, RTRIM(sa1.A1_CGC) clienteCnpj,
           RTRIM(sa1.A1_END) clienteEnd, RTRIM(sa1.A1_BAIRRO) clienteBairro,
           RTRIM(sa1.A1_MUN) clienteMun, RTRIM(sa1.A1_EST) clienteUf, RTRIM(sa1.A1_CEP) clienteCep,
           RTRIM(sa1.A1_DDD) clienteDdd, RTRIM(sa1.A1_TEL) clienteTel, RTRIM(sa1.A1_EMAIL) clienteEmail,
           f2.F2_VALMERC valMerc, f2.F2_VALBRUT valBruto, f2.F2_VALICM valIcms,
           f2.F2_VALIPI valIpi, f2.F2_VALPIS valPis, f2.F2_VALCOFI valCofins,
           f2.F2_VOLUME1 volumes, f2.F2_PBRUTO pesoBruto, f2.F2_PLIQUI pesoLiquido,
           f2.F2_ESPECI1 especie,
           RTRIM(f2.F2_TRANSP) transpCod, RTRIM(sa4.A4_NOME) transpNome
          FROM SF2010 f2 WITH (NOLOCK)
          LEFT JOIN SA1010 sa1 WITH (NOLOCK)
            ON f2.F2_CLIENTE = sa1.A1_COD AND f2.F2_LOJA = sa1.A1_LOJA AND sa1.D_E_L_E_T_ <> '*'
          LEFT JOIN SA4010 sa4 WITH (NOLOCK)
            ON f2.F2_TRANSP = sa4.A4_COD AND sa4.D_E_L_E_T_ <> '*'
         WHERE f2.F2_FILIAL = '01' AND f2.D_E_L_E_T_ <> '*'
           AND f2.F2_DOC = @doc AND f2.F2_SERIE = @serie`,
        { doc, serie }
      );
      if (!cab.length) return res.status(404).json({ message: 'NF nao encontrada.' });

      const itens = await Protheus.connectAndQuery(
        `SELECT RTRIM(d2.D2_ITEM) item, RTRIM(d2.D2_COD) cod,
                RTRIM(sb1.B1_DESC) descricao, RTRIM(d2.D2_UM) um,
                d2.D2_QUANT qtd, d2.D2_PRCVEN vunit, d2.D2_TOTAL total,
                RTRIM(d2.D2_CF) cfop,
                d2.D2_VALICM icms, d2.D2_VALIPI ipi,
                d2.D2_DIFAL difal, d2.D2_VALFECP fcp,
                d2.D2_PEDIDO pedido
           FROM SD2010 d2 WITH (NOLOCK)
           LEFT JOIN SB1010 sb1 WITH (NOLOCK)
             ON sb1.B1_COD = d2.D2_COD AND sb1.D_E_L_E_T_ <> '*'
          WHERE d2.D_E_L_E_T_ <> '*' AND d2.D2_FILIAL = '01'
            AND d2.D2_DOC = @doc AND d2.D2_SERIE = @serie
          ORDER BY d2.D2_ITEM`,
        { doc, serie }
      );

      const c = cab[0];
      return res.json({
        cabecalho: {
          doc: trim(c.doc), serie: trim(c.serie), emissao: trim(c.emissao),
          cliente: {
            cod: trim(c.clienteCod), loja: trim(c.clienteLoja),
            nome: trim(c.clienteNome), cnpj: trim(c.clienteCnpj),
            endereco: trim(c.clienteEnd), bairro: trim(c.clienteBairro),
            municipio: trim(c.clienteMun), uf: trim(c.clienteUf), cep: trim(c.clienteCep),
            ddd: trim(c.clienteDdd), telefone: trim(c.clienteTel), email: trim(c.clienteEmail)
          },
          transportadora: { cod: trim(c.transpCod), nome: trim(c.transpNome) },
          valores: {
            mercadoria: toN(c.valMerc), bruto: toN(c.valBruto),
            icms: toN(c.valIcms), ipi: toN(c.valIpi),
            pis: toN(c.valPis), cofins: toN(c.valCofins)
          },
          carga: {
            volumes: toN(c.volumes), pesoBruto: toN(c.pesoBruto),
            pesoLiquido: toN(c.pesoLiquido), especie: trim(c.especie)
          }
        },
        itens: itens.map(i => ({
          item: trim(i.item),
          cod: trim(i.cod),
          descricao: trim(i.descricao),
          um: trim(i.um),
          qtd: toN(i.qtd),
          vunit: toN(i.vunit),
          total: toN(i.total),
          cfop: trim(i.cfop),
          icms: toN(i.icms), ipi: toN(i.ipi),
          difal: toN(i.difal), fcp: toN(i.fcp),
          pedido: trim(i.pedido)
        })),
        totais: {
          itens: itens.length,
          qtdTotal:  itens.reduce((s, i) => s + toN(i.qtd), 0),
          difalTotal: itens.reduce((s, i) => s + toN(i.difal), 0),
          fcpTotal:   itens.reduce((s, i) => s + toN(i.fcp), 0)
        }
      });
    } catch (err) {
      console.error('Erro expedicao/nf-detalhe:', err);
      return res.status(500).json({ message: 'Erro ao consultar NF: ' + err.message });
    }
  }
});

// GET /qualificacao/protheus/pedido/:numero — pré-preenche a inspeção a partir do
// PEDIDO DE COMPRA (SC7): fornecedor, itens, quantidade e a entrega PREVISTA
// (C7_DATPRF), mais as NFs/pré-notas já digitadas para o pedido e a última inspeção
// de cada item (ESP., critério, instrumento e nível para repetir). Leitura apenas.
//
// Também diz, antes de o inspetor digitar, se o recebimento está liberado para o fornecedor
// (bloqueio por plano de ação C/D, inativo, suspenso; D = só inspeção 100%), se a entrega é
// medida pela data de ENTREGA (nacional) ou de COLETA (importado), e a criticidade de cada
// item na lista de itens críticos (alerta se o fornecedor não está qualificado nela).
//
// ⚠️ C7_DATPRF pode ser reescrita pela própria intranet (Compras, perm 4006). Quando
// isso aconteceu, a resposta traz o histórico (de → para) para o inspetor ver que a
// data prevista — base do índice P — foi movida.
// Perm 23002+.

const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');
const { situacaoRecebimento } = require('../../services/qfInspecao');
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

const ymd = (s) => { const v = Q.trim(s); return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null; };

module.exports = (app) => ({
  verb: 'get',
  route: '/protheus/pedido/:numero',
  middlewares: [Q.mw(app, 'inspetor')],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const dig = Q.trim(req.params.numero).replace(/\D/g, '');
    if (!dig || dig.length > 6) return res.status(400).json({ message: 'Informe o número do pedido de compra.' });
    const numero = dig.padStart(6, '0');
    try {
      let itens, notas;
      try {
        itens = await Protheus.connectAndQuery(
          `SELECT RTRIM(c7.C7_NUM) num, RTRIM(c7.C7_ITEM) item, RTRIM(c7.C7_PRODUTO) produto, RTRIM(COALESCE(b1.B1_DESC, c7.C7_DESCRI, '')) descricao,
                  RTRIM(COALESCE(b1.B1_TIPO, '')) tipo, RTRIM(c7.C7_UM) um, c7.C7_QUANT quant, c7.C7_QUJE quje,
                  RTRIM(c7.C7_DATPRF) datprf, RTRIM(c7.C7_EMISSAO) emissao, RTRIM(c7.C7_FORNECE) fornece, RTRIM(c7.C7_LOJA) loja,
                  RTRIM(ISNULL(c7.C7_RESIDUO, '')) residuo, RTRIM(COALESCE(a2.A2_NOME, '')) fornecedor_nome
             FROM SC7010 c7 WITH (NOLOCK)
             LEFT JOIN SB1010 b1 WITH (NOLOCK) ON b1.B1_COD = c7.C7_PRODUTO AND b1.D_E_L_E_T_ <> '*'
             LEFT JOIN SA2010 a2 WITH (NOLOCK) ON a2.A2_COD = c7.C7_FORNECE AND a2.A2_LOJA = c7.C7_LOJA AND a2.D_E_L_E_T_ <> '*'
            WHERE c7.D_E_L_E_T_ <> '*' AND c7.C7_FILIAL = '01' AND c7.C7_NUM = @num
            ORDER BY c7.C7_ITEM`, { num: numero });
        notas = itens.length ? await Protheus.connectAndQuery(
          `SELECT RTRIM(d1.D1_DOC) doc, RTRIM(d1.D1_SERIE) serie, RTRIM(d1.D1_ITEM) item, RTRIM(d1.D1_ITEMPC) itempc, RTRIM(d1.D1_COD) produto,
                  d1.D1_QUANT quant, RTRIM(d1.D1_DTDIGIT) dtdigit, RTRIM(ISNULL(d1.D1_LOTECTL, '')) lote,
                  RTRIM(ISNULL(f1.F1_RECBMTO, '')) recbmto, RTRIM(ISNULL(f1.F1_STATUS, '')) status
             FROM SD1010 d1 WITH (NOLOCK)
             LEFT JOIN SF1010 f1 WITH (NOLOCK) ON f1.F1_FILIAL = d1.D1_FILIAL AND f1.F1_DOC = d1.D1_DOC AND f1.F1_SERIE = d1.D1_SERIE
                    AND f1.F1_FORNECE = d1.D1_FORNECE AND f1.F1_LOJA = d1.D1_LOJA AND f1.D_E_L_E_T_ <> '*'
            WHERE d1.D_E_L_E_T_ <> '*' AND d1.D1_FILIAL = '01' AND d1.D1_PEDIDO = @num
            ORDER BY d1.D1_DTDIGIT DESC, d1.D1_DOC`, { num: numero }) : [];
      } catch (e) {
        if (ehConexao(e)) return res.status(503).json({ message: MSG_INDISPONIVEL, conexao: true });
        throw e;
      }
      if (!itens.length) return res.status(404).json({ message: `Pedido de compra ${numero} não encontrado no Protheus.` });

      const codForn = itens[0].fornece;
      const [modulo] = await Pg.connectAndQuery(
        `SELECT id, codigo, razao_social, status_qualificacao, criticidades, nacional, ativo, classificacao, iqf_medio, inspecao_100,
                suspensao_tipo, motivo_suspensao, plano_acao_iqf IS NOT NULL AS tem_plano
           FROM tab_qf_fornecedor WHERE codigo = @c`, { c: codForn });

      const produtos = [...new Set(itens.map(i => i.produto))];
      const ultimas = await Pg.connectAndQuery(
        `SELECT DISTINCT ON (LTRIM(cod_item, '0')) LTRIM(cod_item, '0') chave, rel_insp, data_inspecao, nivel_inspecao, especificacao,
                criterio_aceitacao, instrumento_utilizado, resultado_descricao, iqf, nc
           FROM tab_qf_inspecao
          WHERE NOT excluido AND LTRIM(cod_item, '0') = ANY(@prods)
          ORDER BY LTRIM(cod_item, '0'), data_inspecao DESC NULLS LAST, rel_insp DESC`,
        { prods: produtos.map(p => p.replace(/^0+/, '')) });
      const ultimaDe = new Map(ultimas.map(u => [u.chave, u]));

      const crit = await Pg.connectAndQuery(`SELECT produto_chave, criticidade, descricao FROM tab_qf_item_critico WHERE ativo AND produto_chave = ANY(@k)`,
        { k: produtos.map(R.chaveItem) });
      const critDe = new Map(crit.map(c => [c.produto_chave, c.criticidade]));
      const niveis = await Q.niveisDoUsuario(Pg, req);
      const sit = situacaoRecebimento(modulo || null, niveis);
      const critForn = modulo ? R.normCriticidades(modulo.criticidades) : [];

      const datprf = await Pg.connectAndQuery(
        `SELECT entidade_id, meta->>'anterior' anterior, meta->>'nova' nova, usuario_nome, criado_em
           FROM tab_auditoria WHERE acao = 'ALTERAR_PREVISAO_ENTREGA' AND entidade = 'pedido_compra' AND entidade_id LIKE @pat
          ORDER BY criado_em`, { pat: `%/${numero}/%` });

      return res.json({
        pedido: numero,
        fornecedor: { codigo: codForn, loja: itens[0].loja, nome: itens[0].fornecedor_nome, modulo: modulo || null,
          recebimento: sit, tipoPrazo: modulo && modulo.nacional === false ? 'COLETA' : 'ENTREGA' },
        itens: itens.map(i => ({
          item: i.item, produto: i.produto, descricao: i.descricao, tipo: i.tipo, um: i.um,
          quant: Number(i.quant), quje: Number(i.quje), saldo: Math.max(0, Number(i.quant) - Number(i.quje)),
          eliminado: i.residuo === 'S', datprf: ymd(i.datprf), emissao: ymd(i.emissao),
          datprfAlteracoes: datprf.filter(d => d.entidade_id.endsWith(`/${numero}/${i.item}`))
            .map(d => ({ de: ymd(d.anterior), para: ymd(d.nova), por: d.usuario_nome, em: d.criado_em })),
          ultimaInspecao: ultimaDe.get(i.produto.replace(/^0+/, '')) || null,
          criticidade: critDe.get(R.chaveItem(i.produto)) || null,
          foraDaQualificacao: !!(critDe.get(R.chaveItem(i.produto)) && modulo && !critForn.includes(critDe.get(R.chaveItem(i.produto))))
        })),
        notas: notas.map(n => ({ ...n, quant: Number(n.quant), dtdigit: ymd(n.dtdigit), recbmto: ymd(n.recbmto), preNota: n.status === '' }))
      });
    } catch (err) { return Q.falha(res, 'consultar o pedido de compra', err); }
  }
});

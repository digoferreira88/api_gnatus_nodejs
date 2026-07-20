// GET /financeiro/liberacao/credito/:cod/:loja
//
// Painel 360 de Análise de Crédito do cliente (ao clicar no nome na tela de
// Liberação Financeira). Junta:
//   - cadastro de crédito da SA1 (risco, classe, limite, vencimento, maior compra)
//   - exposição AO VIVO: títulos em aberto (SE1) + pedidos em carteira (SC6)
//   - indicadores de risco (atraso médio, protestos, cheques devolvidos)
//   - lista dos títulos em aberto
//
// Critérios alinhados com o módulo de Cobrança: usa E1_VENCREA (vencimento real),
// exclui E1_TIPO IN ('RA','NCC') e considera em aberto = E1_SALDO > 0.
//
// Permissão 8006 (edição) ou 8007 (somente visualização).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8006, 8007]);

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

// Forma de pagamento do titulo (E1_FORMAPG) — mesma tabela do modulo de Cobranca.
const FORMAS_PGTO = {
  '1': 'Cheque', '2': 'Dinheiro', '3': 'Cartão', '4': 'Boleto Bancário', '5': 'Não informado',
  '6': 'Financiamento', '7': 'Cartão BNDS', '8': 'Bonificação', '9': 'Consignado',
  'B': 'Antecipação Parcelada', 'A': 'Futuro Garantido', '': 'Não informado'
};
const descreverFormaPgto = (cod) => FORMAS_PGTO[cod] || `Forma ${cod}`;

module.exports = (app) => ({
  verb: 'get',
  route: '/liberacao/credito/:cod/:loja',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const cod  = trim(req.params.cod);
    const loja = trim(req.params.loja);
    if (!cod) return res.status(400).json({ message: 'cod do cliente é obrigatório.' });

    try {
      // 1) Cadastro de crédito (SA1)
      const sa1Rows = await Protheus.connectAndQuery(`
        SELECT RTRIM(A1_NOME)  nome,
               RTRIM(A1_CGC)   cgc,
               RTRIM(A1_EST)   uf,
               RTRIM(A1_MUN)   municipio,
               RTRIM(A1_RISCO) risco,
               RTRIM(A1_CLASSE) classe,
               A1_LC           lc,
               A1_LCFIN        lcfin,
               RTRIM(A1_VENCLC) venclc,
               A1_MCOMPRA      maiorCompra,
               A1_METR         atrasoMedio,
               A1_TITPROT      titProtestados,
               A1_CHQDEVO      chequesDevolvidos,
               RTRIM(A1_DTULCHQ) dtUltimoCheque,
               A1_SALDUP       saldoDuplicatasCad,
               A1_SALPED       saldoPedidosCad
          FROM SA1010 WITH (NOLOCK)
         WHERE A1_COD = @cod AND A1_LOJA = @loja AND D_E_L_E_T_ <> '*'`,
        { cod, loja }
      );
      if (!sa1Rows.length) {
        return res.status(404).json({ message: 'Cliente não encontrado na SA1.' });
      }
      const c = sa1Rows[0];

      // 2) Títulos em aberto (SE1)
      const titRows = await Protheus.connectAndQuery(`
        SELECT RTRIM(E1_PREFIXO) prefixo,
               RTRIM(E1_NUM)     numero,
               RTRIM(E1_PARCELA) parcela,
               RTRIM(E1_TIPO)    tipo,
               RTRIM(E1_FORMAPG) formaPgto,
               RTRIM(E1_EMISSAO) emissao,
               RTRIM(E1_VENCTO)  vencimento,
               RTRIM(E1_VENCREA) vencimentoReal,
               E1_VALOR          valor,
               E1_SALDO          saldo,
               RTRIM(E1_NATUREZ) natureza,
               DATEDIFF(day, CONVERT(date, E1_VENCREA, 112), GETDATE()) diasAtraso
          FROM SE1010 WITH (NOLOCK)
         WHERE E1_FILIAL = '01' AND E1_CLIENTE = @cod AND E1_LOJA = @loja
           AND D_E_L_E_T_ <> '*' AND E1_SALDO > 0
           AND RTRIM(E1_TIPO) NOT IN ('RA', 'NCC')
         ORDER BY E1_VENCREA`,
        { cod, loja }
      );
      const titulos = titRows.map(t => ({
        prefixo: trim(t.prefixo), numero: trim(t.numero), parcela: trim(t.parcela), tipo: trim(t.tipo),
        emissao: trim(t.emissao), vencimento: trim(t.vencimento), vencimentoReal: trim(t.vencimentoReal),
        valor: N(t.valor), saldo: N(t.saldo), natureza: trim(t.natureza),
        formaPgto: trim(t.formaPgto), formaPgtoNome: descreverFormaPgto(trim(t.formaPgto)),
        diasAtraso: N(t.diasAtraso)
      }));

      const exposTitulos = titulos.reduce((acc, t) => {
        acc.qtd += 1;
        acc.total += t.saldo;
        if (t.diasAtraso > 0) { acc.vencido += t.saldo; if (t.diasAtraso > acc.maiorAtraso) acc.maiorAtraso = t.diasAtraso; }
        else acc.aVencer += t.saldo;
        return acc;
      }, { qtd: 0, total: 0, vencido: 0, aVencer: 0, maiorAtraso: 0 });

      // 3) Pedidos em carteira (SC6) — saldo em aberto (qtd a entregar × preço)
      let exposPedidos = { qtd: 0, saldo: 0 };
      try {
        const pedRows = await Protheus.connectAndQuery(`
          SELECT COUNT(DISTINCT C6_NUM) qtd,
                 SUM((C6_QTDVEN - C6_QTDENT) * C6_PRCVEN) saldo
            FROM SC6010 WITH (NOLOCK)
           WHERE C6_FILIAL = '01' AND C6_CLI = @cod AND C6_LOJA = @loja
             AND D_E_L_E_T_ <> '*'
             AND (C6_QTDVEN - C6_QTDENT) > 0`,
          { cod, loja }
        );
        if (pedRows.length) exposPedidos = { qtd: N(pedRows[0].qtd), saldo: N(pedRows[0].saldo) };
      } catch (e) {
        console.warn('liberacao-credito: falha ao calcular pedidos em carteira —', e.message);
      }

      const totalExposicao = exposTitulos.total + exposPedidos.saldo;
      const lc = N(c.lc);
      const limiteDisponivel = lc > 0 ? lc - totalExposicao : null;

      return res.json({
        cliente: { cod, loja, nome: trim(c.nome), cgc: trim(c.cgc), uf: trim(c.uf), municipio: trim(c.municipio) },
        cadastro: {
          risco: trim(c.risco),
          classe: trim(c.classe),
          limiteCredito: lc,
          limiteFinanceiro: N(c.lcfin),
          vencimentoLimite: trim(c.venclc),
          maiorCompra: N(c.maiorCompra),
          saldoDuplicatasCadastro: N(c.saldoDuplicatasCad),
          saldoPedidosCadastro: N(c.saldoPedidosCad)
        },
        exposicao: {
          titulos: exposTitulos,
          pedidos: exposPedidos,
          totalExposicao,
          limiteDisponivel
        },
        indicadores: {
          atrasoMedioDias: N(c.atrasoMedio),
          titulosProtestados: N(c.titProtestados),
          chequesDevolvidos: N(c.chequesDevolvidos),
          dataUltimoCheque: trim(c.dtUltimoCheque)
        },
        titulos,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro financeiro/liberacao credito:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

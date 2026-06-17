// GET /cobranca/relatorio-receber?inicio=YYYY-MM-DD&fim=YYYY-MM-DD
// Replica o relatório PHP legado "RELATÓRIO DE CONTAS A RECEBER":
// títulos do CR (SE1) com SALDO > 0 e VENCIMENTO no período, filial 01.
// ~45 colunas (joins p/ tipo, natureza, portador, situação, cliente, conta
// contábil, centro de custo, BU, NF, expedição). Valor Atualizado = saldo +
// juros por dias de atraso (3% a.m. se conta 'FUNDOS', senão 2% a.m.) — mesma
// fórmula do PHP. Backend devolve JSON; o XLSX é montado no frontend.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002, 9003, 9004]);
const trim = (v) => String(v == null ? '' : v).trim();
const toNumber = (v) => Number(v || 0);

// UF -> região (mesmo mapa de vendas.relatorio-vendas.js = get_regiao_venda)
const REGIOES = {
  Norte: ['AC', 'AM', 'AP', 'PA', 'RO', 'RR', 'TO'],
  Nordeste: ['AL', 'BA', 'CE', 'MA', 'PB', 'PE', 'PI', 'RN', 'SE'],
  CentroOeste: ['DF', 'GO', 'MT', 'MS'],
  Sudeste: ['ES', 'MG', 'RJ', 'SP'],
  Sul: ['PR', 'RS', 'SC']
};
const regiaoPorUF = {};
Object.entries(REGIOES).forEach(([r, ufs]) => ufs.forEach(uf => { regiaoPorUF[uf] = r === 'CentroOeste' ? 'Centro-Oeste' : r; }));

const FORMAS_PGTO = {
  '1': 'Cheque', '2': 'Dinheiro', '3': 'Cartão', '4': 'Boleto Bancário',
  '5': 'Não informado', '6': 'Financiamento', '7': 'Cartão BNDS',
  '8': 'Bonificação', '9': 'Consignado',
  'B': 'Antecipação Parcelada', 'A': 'Futuro Garantido', '': 'Não informado'
};
const formaPgtoLabel = (cod) => FORMAS_PGTO[trim(cod)] || `Forma ${trim(cod)}`;
const toProtheusDate = (iso) => { const s = String(iso || '').replace(/-/g, '').slice(0, 8); return /^\d{8}$/.test(s) ? s : null; };

module.exports = (app) => ({
  verb: 'get',
  route: '/relatorio-receber',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const dtInicio = toProtheusDate(req.query.inicio);
    const dtFim = toProtheusDate(req.query.fim);
    if (!dtInicio || !dtFim) return res.status(400).json({ message: 'Parâmetros inicio e fim são obrigatórios (YYYY-MM-DD).' });

    const sql = `
      SELECT
        RTRIM(SE1.E1_FILIAL) Filial, RTRIM(SE1.E1_PREFIXO) Prefixo, RTRIM(SE1.E1_NUM) Numero,
        RTRIM(SE1.E1_PARCELA) Parcela, RTRIM(SE1.E1_TIPO) CodTipo, RTRIM(SX5.X5_DESCRI) Tipo,
        RTRIM(SE1.E1_NATUREZ) CodNatureza, RTRIM(SED.ED_DESCRIC) Natureza,
        RTRIM(SE1.E1_PORTADO) CodPortador, RTRIM(SA6.A6_NOME) Portador, RTRIM(SA6.A6_AGENCIA) Agencia,
        RTRIM(SA6.A6_NUMCON) CC, RTRIM(SA6.A6_CORRENT) Conta,
        RTRIM(SE1.E1_SITUACA) CodSituacao, RTRIM(FRV.FRV_DESCRI) Situacao,
        RTRIM(SE1.E1_LOJA) Loja, RTRIM(SE1.E1_CLIENTE) CodCliente, RTRIM(SA1.A1_NOME) Cliente,
        RTRIM(SA1.A1_CGC) Cgc, RTRIM(SE1.E1_NOMCLI) Fantasia, RTRIM(SA1.A1_EST) UF,
        SE1.E1_EMISSAO Emissao, SE1.E1_VENCORI VenctoOri, SE1.E1_VENCTO Vencimento, SE1.E1_VENCREA VenctoReal,
        (CASE WHEN SE1.E1_VENCREA < CONVERT(varchar, getdate(), 112) THEN 'VENCIDO' ELSE 'A VENCER' END) Vencido,
        datediff(DAY, getdate(), SE1.E1_VENCREA) Dias,
        datediff(DAY, getdate(), SE1.E1_VENCORI) DiasOri,
        SE1.E1_VALOR Valor, SE1.E1_SALDO Saldo, SE1.E1_BAIXA DtBaixa,
        RTRIM(SE1.E1_FORMAPG) FormaPgto, RTRIM(SE1.E1_ZCARTAO) TransCartao, RTRIM(SE1.E1_HIST) Historico,
        RTRIM(SE1.E1_DEBITO) CodDebito, RTRIM(CT1.CT1_DESC01) ContaDebito,
        RTRIM(SE1.E1_CCUSTO) CodCCusto, RTRIM(CTT.CTT_DESC01) CentroCusto,
        RTRIM(SE1.E1_ZTIPO) CodBU, RTRIM(BUX5.X5_DESCRI) BU,
        RTRIM(SE1.E1_PEDIDO) Pedido, RTRIM(SC5.C5_ZGERFIN) GerouTP, RTRIM(SC5.C5_NOTA) NFE,
        NFEXP.expedicao DtExpedicao, RTRIM(NFEXP.rastreio) Rastreio
      FROM dbo.SE1010 SE1 WITH (NOLOCK)
      LEFT JOIN dbo.SA1010 SA1 WITH (NOLOCK) ON (SE1.E1_CLIENTE=SA1.A1_COD AND SA1.D_E_L_E_T_<>'*' AND SE1.E1_LOJA=SA1.A1_LOJA)
      LEFT JOIN dbo.SC5010 SC5 WITH (NOLOCK) ON (SE1.E1_PEDIDO=SC5.C5_NUM AND SC5.D_E_L_E_T_<>'*' AND SC5.C5_FILIAL='01')
      LEFT JOIN dbo.SX5010 SX5 WITH (NOLOCK) ON (SE1.E1_TIPO=SX5.X5_CHAVE AND SX5.X5_TABELA='05')
      LEFT JOIN dbo.SED010 SED WITH (NOLOCK) ON (SE1.E1_NATUREZ=SED.ED_CODIGO AND SED.D_E_L_E_T_<>'*')
      LEFT JOIN dbo.SA6010 SA6 WITH (NOLOCK) ON (SE1.E1_PORTADO=SA6.A6_COD AND SE1.E1_AGEDEP=SA6.A6_AGENCIA AND SE1.E1_CONTA=SA6.A6_NUMCON AND SA6.D_E_L_E_T_<>'*')
      LEFT JOIN dbo.CT1010 CT1 WITH (NOLOCK) ON (SE1.E1_DEBITO=CT1.CT1_CONTA AND CT1.D_E_L_E_T_<>'*')
      LEFT JOIN dbo.CTT010 CTT WITH (NOLOCK) ON (SE1.E1_CCUSTO=CTT.CTT_CUSTO AND CTT.D_E_L_E_T_<>'*' AND CTT.CTT_FILIAL='01')
      LEFT JOIN dbo.FRV010 FRV WITH (NOLOCK) ON (SE1.E1_SITUACA=FRV.FRV_CODIGO AND FRV.D_E_L_E_T_<>'*')
      LEFT JOIN dbo.SX5010 BUX5 WITH (NOLOCK) ON (BUX5.X5_TABELA='Z1' AND RTRIM(BUX5.X5_CHAVE)=RTRIM(SE1.E1_ZTIPO) AND ISNULL(BUX5.D_E_L_E_T_,' ')=' ')
      LEFT JOIN dbo.nf_expedicao NFEXP WITH (NOLOCK) ON (SC5.C5_NOTA=NFEXP.z1_doc)
      WHERE SE1.E1_FILIAL='01' AND SE1.D_E_L_E_T_<>'*'
        AND SE1.E1_VENCTO >= @inicio AND SE1.E1_VENCTO <= @fim
        AND SE1.E1_SALDO > 0
      ORDER BY SE1.E1_VENCTO, SE1.E1_NUM, SE1.E1_PARCELA`;

    try {
      const rows = await Protheus.connectAndQuery(sql, { inicio: dtInicio, fim: dtFim });

      const dados = rows.map(r => {
        const saldo = toNumber(r.Saldo);
        const dias = toNumber(r.Dias);                         // negativo = vencido
        const conta = trim(r.Conta).toUpperCase();
        const taxaDiaria = (conta === 'FUNDOS' ? 3 : 2) / 30;
        const valorAtualizado = saldo * (1 + ((taxaDiaria * (dias * -1)) / 100));   // fórmula do PHP
        return {
          filial: trim(r.Filial), prefixo: trim(r.Prefixo), numero: trim(r.Numero), parcela: trim(r.Parcela),
          codTipo: trim(r.CodTipo), tipo: trim(r.Tipo),
          codNatureza: trim(r.CodNatureza), natureza: trim(r.Natureza),
          codPortador: trim(r.CodPortador), portador: trim(r.Portador), agencia: trim(r.Agencia), cc: trim(r.CC), conta: trim(r.Conta),
          codSituacao: trim(r.CodSituacao), situacao: trim(r.Situacao),
          loja: trim(r.Loja), codCliente: trim(r.CodCliente), cliente: trim(r.Cliente),
          cgc: trim(r.Cgc).replace(/\D/g, ''), fantasia: trim(r.Fantasia),
          uf: trim(r.UF), regiao: regiaoPorUF[trim(r.UF)] || '',
          emissao: trim(r.Emissao), venctoOri: trim(r.VenctoOri), vencimento: trim(r.Vencimento), venctoReal: trim(r.VenctoReal),
          vencido: trim(r.Vencido), dias, diasOri: toNumber(r.DiasOri),
          valor: toNumber(r.Valor), saldo, valorAtualizado: +valorAtualizado.toFixed(2),
          dtBaixa: trim(r.DtBaixa), formaPgto: formaPgtoLabel(r.FormaPgto), transCartao: trim(r.TransCartao), historico: trim(r.Historico),
          codDebito: trim(r.CodDebito), contaDebito: trim(r.ContaDebito), codCCusto: trim(r.CodCCusto), centroCusto: trim(r.CentroCusto),
          bu: trim(r.BU) || trim(r.CodBU), pedido: trim(r.Pedido), gerouTP: trim(r.GerouTP), nfe: trim(r.NFE),
          dtExpedicao: trim(r.DtExpedicao), rastreio: trim(r.Rastreio)
        };
      });

      const totalSaldo = dados.reduce((s, d) => s + d.saldo, 0);
      return res.json({
        periodo: { inicio: dtInicio, fim: dtFim },
        totalRegistros: dados.length,
        totalSaldo: +totalSaldo.toFixed(2),
        geradoEm: new Date().toISOString(),
        dados
      });
    } catch (error) {
      console.error('Erro em cobranca/relatorio-receber:', error);
      return res.status(500).json({ message: 'Erro ao gerar relatório de contas a receber: ' + error.message });
    }
  }
});

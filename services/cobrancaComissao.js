// services/cobrancaComissao.js — motor da comissão de cobrança.
// Comissão = valor RECUPERADO (boleto baixado/pago em atraso no mês) × % da FAIXA
// de atraso na data do pagamento. Reusa a definição de "recuperado" da aba
// Recuperados (E1_BAIXA no período, DATEDIFF(E1_VENCREA,E1_BAIXA)). Só boleto
// (E1_FORMAPG='4'); BUs configuradas são excluídas da base.

const trim = (v) => String(v == null ? '' : v).trim();
const toN  = (v) => Number(v || 0);

// Carrega config (colaborador), faixas e BUs excluídas.
async function carregarConfig(Pg) {
  const cfg = await Pg.connectAndQuery(
    `SELECT c.colaborador_id, u.nome AS colaborador_nome
       FROM tab_cobranca_comissao_config c
       LEFT JOIN tab_intranet_usr u ON u.id = c.colaborador_id
      WHERE c.id = 1`, {});
  const faixasRows = await Pg.connectAndQuery(
    `SELECT id, dias_min, dias_max, pct, ordem FROM tab_cobranca_comissao_faixa
      WHERE ativo = TRUE ORDER BY dias_min`, {});
  const busRows = await Pg.connectAndQuery(
    `SELECT bu_codigo, bu_label FROM tab_cobranca_comissao_bu_excluida ORDER BY bu_label`, {});

  const faixas = faixasRows.map(f => ({
    id: f.id, diasMin: Number(f.dias_min),
    diasMax: f.dias_max == null ? null : Number(f.dias_max),
    pct: toN(f.pct), ordem: Number(f.ordem)
  }));
  const busExcluidas = busRows.map(b => ({ codigo: trim(b.bu_codigo), label: trim(b.bu_label) }));
  return {
    colaboradorId: cfg[0]?.colaborador_id || null,
    colaboradorNome: trim(cfg[0]?.colaborador_nome),
    faixas, busExcluidas
  };
}

// % da faixa cujo intervalo contém o atraso (0 se nenhuma faixa cobre).
function pctDaFaixa(faixas, atraso) {
  for (const f of faixas) {
    if (atraso >= f.diasMin && (f.diasMax == null || atraso <= f.diasMax)) return f.pct;
  }
  return 0;
}

// Rótulo legível da faixa aplicada (p/ o detalhe).
function rotuloFaixa(faixas, atraso) {
  for (const f of faixas) {
    if (atraso >= f.diasMin && (f.diasMax == null || atraso <= f.diasMax)) {
      return f.diasMax == null ? `${f.diasMin}+ dias` : `${f.diasMin}-${f.diasMax} dias`;
    }
  }
  return 'sem faixa';
}

// Apura a comissão de um mês (competência = mês da baixa, YYYYMM).
async function apurar({ Protheus, Pg }, anoMes) {
  const cfg = await carregarConfig(Pg);
  const excl = new Set(cfg.busExcluidas.map(b => b.codigo).filter(Boolean));

  const rows = await Protheus.connectAndQuery(`
    SELECT RTRIM(se1.E1_CLIENTE) cod, RTRIM(se1.E1_LOJA) loja,
           RTRIM(COALESCE(NULLIF(sa1.A1_NOME, ''), se1.E1_NOMCLI)) nome,
           RTRIM(se1.E1_PREFIXO) prefixo, RTRIM(se1.E1_NUM) numero,
           RTRIM(se1.E1_PARCELA) parcela, RTRIM(se1.E1_TIPO) tipo,
           se1.E1_VALOR valor, se1.E1_VENCREA vencto, se1.E1_BAIXA baixa,
           DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) atraso,
           RTRIM(sc5.C5_ZTIPO) buCod, RTRIM(bu.X5_DESCRI) buLabel
      FROM SE1010 se1 WITH (NOLOCK)
      LEFT JOIN SA1010 sa1 WITH (NOLOCK)
        ON sa1.A1_COD = se1.E1_CLIENTE AND sa1.A1_LOJA = se1.E1_LOJA AND sa1.D_E_L_E_T_ <> '*'
      LEFT JOIN SC5010 sc5 WITH (NOLOCK)
        ON sc5.C5_FILIAL = se1.E1_FILIAL AND sc5.C5_NUM = se1.E1_PEDIDO AND sc5.D_E_L_E_T_ <> '*'
      LEFT JOIN SX5010 bu WITH (NOLOCK)
        ON bu.X5_FILIAL = '  ' AND bu.X5_TABELA = 'Z1'
       AND RTRIM(bu.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND bu.D_E_L_E_T_ <> '*'
     WHERE se1.D_E_L_E_T_ <> '*' AND se1.E1_FILIAL = '01'
       AND RTRIM(se1.E1_FORMAPG) = '4'
       AND RTRIM(se1.E1_TIPO) NOT IN ('RA', 'NCC')
       AND RTRIM(se1.E1_BAIXA) <> '' AND ISDATE(se1.E1_BAIXA) = 1 AND ISDATE(se1.E1_VENCREA) = 1
       AND SUBSTRING(se1.E1_BAIXA, 1, 6) = @anoMes
       AND DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, se1.E1_BAIXA, 112)) >= 0
     ORDER BY se1.E1_BAIXA, nome`,
    { anoMes });

  const detalhe = [];
  let recuperadoTotal = 0, baseComissionavel = 0, comissao = 0, excluidoPorBu = 0, qtdExcl = 0;
  rows.forEach(r => {
    const valor = toN(r.valor), atraso = toN(r.atraso), buCod = trim(r.buCod);
    const buLabel = trim(r.buLabel) || buCod || '(sem BU)';
    if (buCod && excl.has(buCod)) { excluidoPorBu += valor; qtdExcl++; return; }
    const pct = pctDaFaixa(cfg.faixas, atraso);
    const valComissao = valor * pct / 100;
    recuperadoTotal += valor;
    if (pct > 0) baseComissionavel += valor;
    comissao += valComissao;
    detalhe.push({
      cliente: `${trim(r.cod)}/${trim(r.loja)}`, nome: trim(r.nome), bu: buLabel,
      titulo: `${trim(r.numero)}${trim(r.parcela) ? '/' + trim(r.parcela) : ''}`,
      prefixo: trim(r.prefixo), numero: trim(r.numero), parcela: trim(r.parcela), tipo: trim(r.tipo),
      valor: Number(valor.toFixed(2)), vencimento: trim(r.vencto), dataBaixa: trim(r.baixa),
      atraso, faixa: rotuloFaixa(cfg.faixas, atraso),
      pct: Number(pct.toFixed(4)), comissao: Number(valComissao.toFixed(2))
    });
  });

  return {
    config: cfg,
    totais: {
      recuperadoTotal: Number(recuperadoTotal.toFixed(2)),
      baseComissionavel: Number(baseComissionavel.toFixed(2)),
      comissao: Number(comissao.toFixed(2)),
      excluidoPorBu: Number(excluidoPorBu.toFixed(2)),
      qtdTitulos: detalhe.length,
      qtdExcluidos: qtdExcl
    },
    detalhe
  };
}

module.exports = { carregarConfig, pctDaFaixa, rotuloFaixa, apurar };

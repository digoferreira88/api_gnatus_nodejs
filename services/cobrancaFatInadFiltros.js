// Traduz os filtros do dashboard de cobranca (cliente / uf / bu / formaPgto /
// carteira / equipe) em JOINs + condicoes SQL para as queries de:
//   - FATURAMENTO  (SF2010 sf2 + SD2010 sd2)  -> fragmentos fatJoins / fatWhere
//   - INADIMPLENCIA (SE1010 se1)              -> fragmentos inadJoins / inadWhere
//
// Usado pelo card de "safra" (cobranca.dashboard) e pelo grafico
// "Faturamento x Inadimplencia" (cobranca.faturamento-vs-inadimplencia), pra os
// dois respeitarem EXATAMENTE os mesmos filtros e nunca divergirem.
//
// carteira e equipe sao da intranet (Postgres): carteira -> conjunto de clientes
// (tab_cobranca_atribuicao); equipe -> conjunto de BUs (tab_cobranca_bu_equipe,
// comparado pela DESCRICAO da BU, igual o resto do modulo).
//
// Sem filtros, todos os fragmentos voltam vazios -> as queries ficam identicas
// ao comportamento anterior (empresa toda, batendo com o grafico).

const trim = (v) => String(v || '').trim();

// Rotulo da BU igual ao usado no dashboard/grafico: X5_DESCRI, ou
// "<C5_ZTIPO> (Desconhecido)" quando a SX5 nao tem descricao.
const BU_LABEL = `COALESCE(NULLIF(RTRIM(bu_sx5.X5_DESCRI), ''), RTRIM(sc5.C5_ZTIPO) + ' (Desconhecido)')`;

async function montar({ Pg }, query) {
  const cliente  = trim(query.cliente).toUpperCase();
  const uf       = trim(query.uf).toUpperCase();
  const bu       = trim(query.bu).toUpperCase();
  const forma    = trim(query.formaPgto);
  const carteira = trim(query.carteira).toUpperCase();
  const equipe   = trim(query.equipe);

  const params = {};
  const fatConds = [], inadConds = [];
  let fatSa1 = false, fatSc5 = false, fatSx5 = false;
  let inadSa1 = false, inadSc5 = false, inadSx5 = false;

  if (cliente) {
    params.cliente = cliente;
    fatConds.push(`(RTRIM(sf2.F2_CLIENTE) = @cliente OR UPPER(sa1.A1_NOME) LIKE '%' + @cliente + '%')`); fatSa1 = true;
    inadConds.push(`(RTRIM(se1.E1_CLIENTE) = @cliente OR UPPER(sa1.A1_NOME) LIKE '%' + @cliente + '%' OR UPPER(RTRIM(se1.E1_NOMCLI)) LIKE '%' + @cliente + '%')`); inadSa1 = true;
  }
  if (uf) {
    params.uf = uf;
    fatConds.push(`RTRIM(sa1.A1_EST) = @uf`); fatSa1 = true;
    inadConds.push(`RTRIM(sa1.A1_EST) = @uf`); inadSa1 = true;
  }
  if (bu) {
    params.bu = bu;
    fatConds.push(`RTRIM(sc5.C5_ZTIPO) = @bu`); fatSc5 = true;
    inadConds.push(`RTRIM(sc5.C5_ZTIPO) = @bu`); inadSc5 = true;
  }
  if (forma) {
    params.forma = forma;
    // Faturamento: forma vem do pedido (C5_FORMAPG). Inadimplencia: do titulo (E1_FORMAPG).
    fatConds.push(`RTRIM(sc5.C5_FORMAPG) = @forma`); fatSc5 = true;
    inadConds.push(`RTRIM(se1.E1_FORMAPG) = @forma`);
  }
  if (carteira) {
    const rows = await Pg.connectAndQuery(
      `SELECT DISTINCT cliente_cod FROM tab_cobranca_atribuicao WHERE UPPER(TRIM(carteira)) = @cart`,
      { cart: carteira }
    );
    const cods = rows.map(r => trim(r.cliente_cod)).filter(Boolean);
    if (cods.length === 0) {
      fatConds.push('1 = 0'); inadConds.push('1 = 0');   // carteira sem clientes -> vazio
    } else {
      const inList = cods.map((_, i) => `@cart${i}`).join(',');
      cods.forEach((c, i) => { params[`cart${i}`] = c; });
      fatConds.push(`RTRIM(sf2.F2_CLIENTE) IN (${inList})`);
      inadConds.push(`RTRIM(se1.E1_CLIENTE) IN (${inList})`);
    }
  }
  if (equipe) {
    const eqU = equipe.toUpperCase();
    if (eqU === 'B2C' || eqU === 'B2B') {
      // Modelo B2B/B2C (tela Faturamento x Inadimplencia). B2C = 3 equipes;
      // B2B = tudo que NAO e B2C (inclusive titulos sem BU). Nao afeta o dashboard,
      // que passa o nome cru da equipe (cai no else abaixo).
      const b2cRows = await Pg.connectAndQuery(
        `SELECT DISTINCT bu_codigo FROM tab_cobranca_bu_equipe
          WHERE equipe IN ('Comercial Varejo','Digital','Representantes')`, {});
      const labels = b2cRows.map(r => trim(r.bu_codigo)).filter(Boolean);
      if (labels.length) {
        const inList = labels.map((_, i) => `@eqb${i}`).join(',');
        labels.forEach((l, i) => { params[`eqb${i}`] = l; });
        const condB2C  = `${BU_LABEL} IN (${inList})`;
        const condB2B  = `(${BU_LABEL} NOT IN (${inList}) OR ${BU_LABEL} IS NULL)`;
        const cond = eqU === 'B2C' ? condB2C : condB2B;
        fatConds.push(cond);  fatSc5 = true;  fatSx5 = true;
        inadConds.push(cond); inadSc5 = true; inadSx5 = true;
      } else if (eqU === 'B2C') {
        fatConds.push('1 = 0'); inadConds.push('1 = 0');
      }
    } else {
      const rows = await Pg.connectAndQuery(
        `SELECT DISTINCT bu_codigo FROM tab_cobranca_bu_equipe WHERE equipe = @eq`,
        { eq: equipe }
      );
      const labels = rows.map(r => trim(r.bu_codigo)).filter(Boolean);
      if (labels.length === 0) {
        fatConds.push('1 = 0'); inadConds.push('1 = 0');   // equipe sem BUs -> vazio
      } else {
        const inList = labels.map((_, i) => `@eq${i}`).join(',');
        labels.forEach((l, i) => { params[`eq${i}`] = l; });
        fatConds.push(`${BU_LABEL} IN (${inList})`); fatSc5 = true; fatSx5 = true;
        inadConds.push(`${BU_LABEL} IN (${inList})`); inadSc5 = true; inadSx5 = true;
      }
    }
  }

  // ----- JOINs (so os necessarios) -----
  let fatJoins = '';
  if (fatSa1) fatJoins += `
      LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = sf2.F2_CLIENTE AND sa1.A1_LOJA = sf2.F2_LOJA AND sa1.D_E_L_E_T_ <> '*'`;
  if (fatSc5 || fatSx5) fatJoins += `
      LEFT JOIN SC5010 sc5 WITH (NOLOCK) ON sc5.C5_FILIAL = sd2.D2_FILIAL AND sc5.C5_NUM = sd2.D2_PEDIDO AND sc5.D_E_L_E_T_ <> '*'`;
  if (fatSx5) fatJoins += `
      LEFT JOIN SX5010 bu_sx5 WITH (NOLOCK) ON bu_sx5.X5_FILIAL = '  ' AND bu_sx5.X5_TABELA = 'Z1' AND RTRIM(bu_sx5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND bu_sx5.D_E_L_E_T_ <> '*'`;

  let inadJoins = '';
  if (inadSa1) inadJoins += `
      LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = se1.E1_CLIENTE AND sa1.A1_LOJA = se1.E1_LOJA AND sa1.D_E_L_E_T_ <> '*'`;
  if (inadSc5 || inadSx5) inadJoins += `
      LEFT JOIN SC5010 sc5 WITH (NOLOCK) ON sc5.C5_FILIAL = se1.E1_FILIAL AND sc5.C5_NUM = se1.E1_PEDIDO AND sc5.D_E_L_E_T_ <> '*'`;
  if (inadSx5) inadJoins += `
      LEFT JOIN SX5010 bu_sx5 WITH (NOLOCK) ON bu_sx5.X5_FILIAL = '  ' AND bu_sx5.X5_TABELA = 'Z1' AND RTRIM(bu_sx5.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO) AND bu_sx5.D_E_L_E_T_ <> '*'`;

  return {
    params,
    fatJoins, inadJoins,
    fatWhere:  fatConds.length  ? ' AND ' + fatConds.join(' AND ')  : '',
    inadWhere: inadConds.length ? ' AND ' + inadConds.join(' AND ') : '',
    temFiltro: !!(cliente || uf || bu || forma || carteira || equipe)
  };
}

module.exports = { montar };

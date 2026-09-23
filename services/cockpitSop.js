// services/cockpitSop.js — monta o objeto D do Cockpit S&OP (Compras/Planejamento).
//
// O painel foi construído pelo setor como HTML único alimentado por 4 uploads
// (vendas, faturamento, carteira, estoque). Este serviço produz o MESMO objeto `D`
// a partir do Protheus. Contrato e regras: docs/compras/gnatus_cockpit_sop_CONTEXTO.md.
//
// As quatro fontes são relatórios que a intranet já tem, e as regras abaixo são as
// deles (validadas em 22/09/2026 contra a base embutida no HTML):
//   entrada     SC6×SC5, CFOPs de venda, item não bloqueado. ALINHADO ao Relatório
//               de Vendas (23/09/2026): EXCLUI redigitação (C5_ZTIPO<>'RED') e usa
//               preço COM IPI (C6_PRCVEN×(1+IPI%)), não o C6_ZPRCVEN do arquivo do
//               setor. Muda a base de todo o motor (sazonalidade/cenários/book-to-bill).
//   faturamento SD2×SF2, mesmos CFOPs + 6109, valor = D2_VALBRUT − D2_VALDEV,
//               sem nota complementar de ICMS -> ago/26: R$ 7,01 mi, 8.629 un,
//               690 notas (idêntico ao arquivo deles)
//   carteira    services/carteiraRegras.js (mesma do export e do Painel de Estoque);
//               valor oficial = preço COM IPI, como na tela de Carteira
//   estoque     SB2 × SB1, armazém cadastrado no NNR
//
// PEDIDO É MUTÁVEL: a entrada dos últimos meses é revisada para baixo (erosão
// medida por eles: −1,14% em 9 meses). Por isso tab_sop_entrada_snapshot guarda a
// foto de cada geração — é dela que nasce o Demand Bias, o único campo que não sai
// de uma consulta só.

const Carteira = require('./carteiraRegras');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const n2 = (v) => Math.round(N(v) * 100) / 100;
const listaSql = (l) => l.map(c => `'${c}'`).join(',');

// CFOPs de venda. O faturamento inclui 6109 (o relatório de vendas não).
const CFOPS_PEDIDO = ['5105', '5106', '5116', '5117', '5119', '5405', '5933',
  '6105', '6106', '6107', '6108', '6110', '6116', '6117', '6119', '6122', '6123', '6404', '6933'];
const CFOPS_NOTA = [...CFOPS_PEDIDO, '6109'];

const ANOS = ['2023', '2024', '2025', '2026'];
const ANO_BASE = () => Number(process.env.SOP_ANO_BASE || new Date().getFullYear());

const REGIOES = {
  AC: 'Norte', AM: 'Norte', AP: 'Norte', PA: 'Norte', RO: 'Norte', RR: 'Norte', TO: 'Norte',
  AL: 'Nordeste', BA: 'Nordeste', CE: 'Nordeste', MA: 'Nordeste', PB: 'Nordeste', PE: 'Nordeste', PI: 'Nordeste', RN: 'Nordeste', SE: 'Nordeste',
  DF: 'Centro-Oeste', GO: 'Centro-Oeste', MT: 'Centro-Oeste', MS: 'Centro-Oeste',
  ES: 'Sudeste', MG: 'Sudeste', RJ: 'Sudeste', SP: 'Sudeste',
  PR: 'Sul', RS: 'Sul', SC: 'Sul'
};
const NOMES_REGIAO = ['Sudeste', 'Nordeste', 'Sul', 'Centro-Oeste', 'Norte'];
const regiaoDe = (uf) => REGIOES[trim(uf).toUpperCase()] || 'Sudeste';

// Classificadores portados do painel (docs/compras, seção 8). Código com 10+ dígitos
// é sempre peça de reposição; o resto vai por palavra-chave na descrição.
function famOf(descricao, codigo) {
  if (trim(codigo).replace(/\D/g, '').length >= 10) return 'Peças de Reposição';
  const d = trim(descricao).toUpperCase();
  if (d.includes('CONSULTORIO') || d.includes('CONSULTÓRIO')) return 'Consultório Completo';
  if (/RAIO|\sRX|^RX|TOMOGRAF|PANORAM|SENSOR|RADIOGRAF|SCANNER/.test(d)) return 'Imagem / Radiologia';
  if (/AUTOCLAVE|ESTERIL|SELADORA|DESTILAD/.test(d)) return 'Esterilização / Barreira';
  if (/COMPRESSOR|VACUO|VÁCUO|SUGADOR/.test(d)) return 'Infraestrutura (Ar/Vácuo)';
  if (/CANETA|MICROMOTOR|CONTRA.?ANGULO|ALTA ROTA|PECA RETA/.test(d)) return 'Peças de Mão';
  if (/FOTOPOLIMER|ULTRASSOM|ULTRA SOM|JATO|PROFILAXIA|BISTURI|LASER|EASYSONIC/.test(d)) return 'Periféricos Clínicos';
  if (/\bCADEIRA\b|EQUIPO|REFLETOR|UNIDADE AUX/.test(d)) return 'Cadeira / Equipo / Refletor';
  if (/MOCHO|ARMARIO|ARMÁRIO|GABINETE|CARRINHO/.test(d)) return 'Mobiliário Clínico';
  if (/TAXA|FRETE|SERVICO|SERVIÇO|MAO DE OBRA|MÃO DE OBRA|INSTALA|ROYALT|MANUTEN|GARANTIA|TREINAMENTO|CESSÃO/.test(d)) return 'Serviços / Taxas';
  return 'Peças de Reposição';
}

function canalOf(tipo) {
  const t = trim(tipo).toUpperCase();
  if (t.includes('FRANQU')) return 'Franquias';
  if (['CIOSP', 'CIOCE', 'FUTURO GARANTIDO', 'CONESPO', 'INDEX', 'CORIG'].some(k => t.includes(k))) return 'Feiras / Eventos';
  if (t.includes('ATACADO') || t === 'OUTLET') return 'Atacado / Distribuidor';
  if (t.includes('VAREJO')) return 'Varejo (Consultório)';
  if (t.includes('REPRESENTA')) return 'Representações';
  if (t.includes('LICITA')) return 'Licitações';
  if (t.includes('CORPORATIVO')) return 'Corporativo';
  if (['DIGITAL', 'MERCADO LIVRE', 'LANDING', 'GIFT', 'MARKETING'].some(k => t.includes(k))) return 'Digital / E-commerce';
  if (['ASSIST', 'SERVICE', 'CONSERTO', 'VENDAS AT', 'TROCA', 'FALTANTES'].some(k => t.includes(k))) return 'Pós-venda / Serviço';
  if (t.includes('REDIGITA')) return 'Redigitação';
  return 'Outros';
}

// Etapas de liberação, na ordem que o painel desenha (estatus_cod da view pedidos_estatus).
const ETAPA_POR_ESTATUS = {
  10: 'Liberação do comercial', 20: 'Liberação do financeiro', 25: 'Liberação do financeiro',
  30: 'Liberação do planejamento', 40: 'Formulação financeira', 50: 'Liberação de estoque',
  60: 'Aguardando faturamento', 99: 'Aguardando faturamento'
};

const hojeBrasilia = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const ymd = (iso) => trim(iso).replace(/-/g, '');
const zeros = () => Array(12).fill(0);

// ---------------------------------------------------------------------------
// Leituras do Protheus
// ---------------------------------------------------------------------------

// Entrada (pedidos) por mês × UF × BU, com marcação do cliente de licitação IVG.
// Valor = preço COM IPI e SEM redigitação — idêntico ao Relatório de Vendas.
async function lerEntrada(Protheus, ini, fim) {
  return Protheus.connectAndQuery(`
    SELECT LEFT(c5.C5_EMISSAO, 6) ym, RTRIM(sa1.A1_EST) uf,
           COALESCE(NULLIF(RTRIM(bu.X5_DESCRI), ''), RTRIM(c5.C5_ZTIPO)) canal,
           CASE WHEN sa1.A1_NOME LIKE '%IVG%' THEN 1 ELSE 0 END ivg,
           SUM(c6.C6_QTDVEN * ROUND(c6.C6_PRCVEN * (1 + (b1.B1_IPI / 100)), 2)) v,
           SUM(c6.C6_QTDVEN) q, COUNT(DISTINCT c6.C6_NUM) n, COUNT(*) linhas
      FROM SC6010 c6 WITH (NOLOCK)
      JOIN SC5010 c5 WITH (NOLOCK) ON c5.C5_FILIAL = c6.C6_FILIAL AND c5.C5_NUM = c6.C6_NUM AND c5.D_E_L_E_T_ <> '*'
      LEFT JOIN SB1010 b1 WITH (NOLOCK) ON b1.B1_FILIAL = '' AND b1.B1_COD = c6.C6_PRODUTO AND b1.D_E_L_E_T_ <> '*'
      LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = c5.C5_CLIENTE AND sa1.A1_LOJA = c5.C5_LOJACLI AND sa1.D_E_L_E_T_ <> '*'
      LEFT JOIN SX5010 bu WITH (NOLOCK) ON bu.X5_FILIAL = '  ' AND bu.X5_TABELA = 'Z1'
           AND RTRIM(bu.X5_CHAVE) = RTRIM(c5.C5_ZTIPO) AND bu.D_E_L_E_T_ <> '*'
     WHERE c6.D_E_L_E_T_ <> '*' AND c6.C6_FILIAL = '01' AND c5.C5_EMISSAO BETWEEN @ini AND @fim
       AND c6.C6_CF IN (${listaSql(CFOPS_PEDIDO)}) AND c6.C6_BLQ = ' '
       AND RTRIM(c5.C5_ZTIPO) NOT IN ('RED')
     GROUP BY LEFT(c5.C5_EMISSAO, 6), RTRIM(sa1.A1_EST),
              COALESCE(NULLIF(RTRIM(bu.X5_DESCRI), ''), RTRIM(c5.C5_ZTIPO)),
              CASE WHEN sa1.A1_NOME LIKE '%IVG%' THEN 1 ELSE 0 END`, { ini, fim });
}

// Faturamento por mês × UF. Valor = bruto − devolução (mesma conta do relatório).
async function lerFaturamento(Protheus, ini, fim) {
  return Protheus.connectAndQuery(`
    SELECT LEFT(d2.D2_EMISSAO, 6) ym, RTRIM(sa1.A1_EST) uf,
           SUM(d2.D2_VALBRUT - d2.D2_VALDEV) v, SUM(d2.D2_QUANT) q,
           COUNT(DISTINCT d2.D2_DOC) n
      FROM SD2010 d2 WITH (NOLOCK)
      JOIN SF2010 f2 WITH (NOLOCK) ON f2.F2_FILIAL = d2.D2_FILIAL AND f2.F2_DOC = d2.D2_DOC
           AND f2.F2_SERIE = d2.D2_SERIE AND f2.F2_CLIENTE = d2.D2_CLIENTE AND f2.F2_LOJA = d2.D2_LOJA
           AND f2.D_E_L_E_T_ <> '*'
      LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = d2.D2_CLIENTE AND sa1.A1_LOJA = d2.D2_LOJA AND sa1.D_E_L_E_T_ <> '*'
     WHERE d2.D_E_L_E_T_ <> '*' AND d2.D2_FILIAL = '01' AND d2.D2_EMISSAO BETWEEN @ini AND @fim
       AND d2.D2_CF IN (${listaSql(CFOPS_NOTA)}) AND ISNULL(f2.F2_TIPO, 'N') <> 'I'
     GROUP BY LEFT(d2.D2_EMISSAO, 6), RTRIM(sa1.A1_EST)`, { ini, fim });
}

// Faturamento por SKU e mês — alimenta ABC/XYZ, famílias e a demanda do estoque.
async function lerFaturamentoSku(Protheus, ini, fim) {
  return Protheus.connectAndQuery(`
    SELECT RTRIM(d2.D2_COD) cod, RTRIM(b1.B1_DESC) descricao, LEFT(d2.D2_EMISSAO, 6) ym,
           RTRIM(sa1.A1_EST) uf,
           SUM(d2.D2_VALBRUT - d2.D2_VALDEV) v, SUM(d2.D2_QUANT) q
      FROM SD2010 d2 WITH (NOLOCK)
      JOIN SF2010 f2 WITH (NOLOCK) ON f2.F2_FILIAL = d2.D2_FILIAL AND f2.F2_DOC = d2.D2_DOC
           AND f2.F2_SERIE = d2.D2_SERIE AND f2.F2_CLIENTE = d2.D2_CLIENTE AND f2.F2_LOJA = d2.D2_LOJA
           AND f2.D_E_L_E_T_ <> '*'
      LEFT JOIN SB1010 b1 WITH (NOLOCK) ON b1.B1_COD = d2.D2_COD AND b1.D_E_L_E_T_ <> '*'
      LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = d2.D2_CLIENTE AND sa1.A1_LOJA = d2.D2_LOJA AND sa1.D_E_L_E_T_ <> '*'
     WHERE d2.D_E_L_E_T_ <> '*' AND d2.D2_FILIAL = '01' AND d2.D2_EMISSAO BETWEEN @ini AND @fim
       AND d2.D2_CF IN (${listaSql(CFOPS_NOTA)}) AND ISNULL(f2.F2_TIPO, 'N') <> 'I'
     GROUP BY RTRIM(d2.D2_COD), RTRIM(b1.B1_DESC), LEFT(d2.D2_EMISSAO, 6), RTRIM(sa1.A1_EST)`, { ini, fim });
}

// Margem por ano: média de "% Margem Item" ponderada pelo valor, igual ao Relatório
// de Faturamento (linha sem custo entra com margem zero e puxa a média para baixo).
async function lerMargem(Protheus, ini, fim) {
  return Protheus.connectAndQuery(`
    SELECT LEFT(d2.D2_EMISSAO, 4) ano,
           SUM(CASE WHEN (d2.D2_VALBRUT - d2.D2_VALDEV) > 0 AND d2.D2_CUSTO1 > 0
                    THEN (100 - (d2.D2_CUSTO1 / (d2.D2_VALBRUT - d2.D2_VALDEV)) * 100) * (d2.D2_VALBRUT - d2.D2_VALDEV)
                    ELSE 0 END) ponderada,
           SUM(d2.D2_VALBRUT - d2.D2_VALDEV) peso
      FROM SD2010 d2 WITH (NOLOCK)
      JOIN SF2010 f2 WITH (NOLOCK) ON f2.F2_FILIAL = d2.D2_FILIAL AND f2.F2_DOC = d2.D2_DOC
           AND f2.F2_SERIE = d2.D2_SERIE AND f2.F2_CLIENTE = d2.D2_CLIENTE AND f2.F2_LOJA = d2.D2_LOJA
           AND f2.D_E_L_E_T_ <> '*'
     WHERE d2.D_E_L_E_T_ <> '*' AND d2.D2_FILIAL = '01' AND d2.D2_EMISSAO BETWEEN @ini AND @fim
       AND d2.D2_CF IN (${listaSql(CFOPS_NOTA)}) AND ISNULL(f2.F2_TIPO, 'N') <> 'I'
     GROUP BY LEFT(d2.D2_EMISSAO, 4)`, { ini, fim });
}

// Distribuição de dias entre a emissão do pedido e a da nota, por ano. Serve para
// lead time (média/mediana) e idade do pedido faturado (p30/p60 em % do VALOR).
async function lerIdadePedido(Protheus, ini, fim) {
  return Protheus.connectAndQuery(`
    SELECT LEFT(d2.D2_EMISSAO, 4) ano, LEFT(d2.D2_EMISSAO, 6) ym,
           DATEDIFF(DAY, CONVERT(date, c5.C5_EMISSAO, 112), CONVERT(date, d2.D2_EMISSAO, 112)) dias,
           SUM(d2.D2_VALBRUT - d2.D2_VALDEV) v, COUNT(*) n
      FROM SD2010 d2 WITH (NOLOCK)
      JOIN SF2010 f2 WITH (NOLOCK) ON f2.F2_FILIAL = d2.D2_FILIAL AND f2.F2_DOC = d2.D2_DOC
           AND f2.F2_SERIE = d2.D2_SERIE AND f2.F2_CLIENTE = d2.D2_CLIENTE AND f2.F2_LOJA = d2.D2_LOJA
           AND f2.D_E_L_E_T_ <> '*'
      JOIN SC5010 c5 WITH (NOLOCK) ON c5.C5_FILIAL = d2.D2_FILIAL AND c5.C5_NUM = d2.D2_PEDIDO AND c5.D_E_L_E_T_ <> '*'
     WHERE d2.D_E_L_E_T_ <> '*' AND d2.D2_FILIAL = '01' AND d2.D2_EMISSAO BETWEEN @ini AND @fim
       AND d2.D2_CF IN (${listaSql(CFOPS_NOTA)}) AND ISNULL(f2.F2_TIPO, 'N') <> 'I'
       AND LEN(RTRIM(c5.C5_EMISSAO)) = 8
     GROUP BY LEFT(d2.D2_EMISSAO, 4), LEFT(d2.D2_EMISSAO, 6),
              DATEDIFF(DAY, CONVERT(date, c5.C5_EMISSAO, 112), CONVERT(date, d2.D2_EMISSAO, 112))`, { ini, fim });
}

// Acumulado DIÁRIO de entrada e faturamento — curva de quanto do mês já se realizou
// em cada dia (projeção do mês aberto) e espelho do ano anterior.
async function lerDiarios(Protheus, ini, fim) {
  const [ped, fat] = await Promise.all([
    Protheus.connectAndQuery(`
      SELECT LEFT(c5.C5_EMISSAO, 6) ym, RIGHT(RTRIM(c5.C5_EMISSAO), 2) dia,
             SUM(c6.C6_QTDVEN * ROUND(c6.C6_PRCVEN * (1 + (b1.B1_IPI / 100)), 2)) v,
             SUM(c6.C6_QTDVEN) q, COUNT(DISTINCT c6.C6_NUM) n
        FROM SC6010 c6 WITH (NOLOCK)
        JOIN SC5010 c5 WITH (NOLOCK) ON c5.C5_FILIAL = c6.C6_FILIAL AND c5.C5_NUM = c6.C6_NUM AND c5.D_E_L_E_T_ <> '*'
        LEFT JOIN SB1010 b1 WITH (NOLOCK) ON b1.B1_FILIAL = '' AND b1.B1_COD = c6.C6_PRODUTO AND b1.D_E_L_E_T_ <> '*'
       WHERE c6.D_E_L_E_T_ <> '*' AND c6.C6_FILIAL = '01' AND c5.C5_EMISSAO BETWEEN @ini AND @fim
         AND c6.C6_CF IN (${listaSql(CFOPS_PEDIDO)}) AND c6.C6_BLQ = ' '
         AND RTRIM(c5.C5_ZTIPO) NOT IN ('RED')
       GROUP BY LEFT(c5.C5_EMISSAO, 6), RIGHT(RTRIM(c5.C5_EMISSAO), 2)`, { ini, fim }),
    Protheus.connectAndQuery(`
      SELECT LEFT(d2.D2_EMISSAO, 6) ym, RIGHT(RTRIM(d2.D2_EMISSAO), 2) dia,
             SUM(d2.D2_VALBRUT - d2.D2_VALDEV) v, SUM(d2.D2_QUANT) q,
             COUNT(DISTINCT d2.D2_DOC) n
        FROM SD2010 d2 WITH (NOLOCK)
        JOIN SF2010 f2 WITH (NOLOCK) ON f2.F2_FILIAL = d2.D2_FILIAL AND f2.F2_DOC = d2.D2_DOC
             AND f2.F2_SERIE = d2.D2_SERIE AND f2.F2_CLIENTE = d2.D2_CLIENTE AND f2.F2_LOJA = d2.D2_LOJA
             AND f2.D_E_L_E_T_ <> '*'
       WHERE d2.D_E_L_E_T_ <> '*' AND d2.D2_FILIAL = '01' AND d2.D2_EMISSAO BETWEEN @ini AND @fim
         AND d2.D2_CF IN (${listaSql(CFOPS_NOTA)}) AND ISNULL(f2.F2_TIPO, 'N') <> 'I'
       GROUP BY LEFT(d2.D2_EMISSAO, 6), RIGHT(RTRIM(d2.D2_EMISSAO), 2)`, { ini, fim })
  ]);
  return { ped, fat };
}

// Carteira em aberto, nível de item: mesma regra do export, mais etapa de liberação,
// canal e o preço COM IPI (valor oficial da tela de Carteira).
async function lerCarteira(Protheus) {
  return Protheus.connectAndQuery(`
    SELECT RTRIM(c6.C6_NUM) pedido, RTRIM(c6.C6_PRODUTO) cod, RTRIM(c6.C6_DESCRI) descricao,
           (c6.C6_QTDVEN - c6.C6_QTDENT) saldo, c6.C6_ENTREG entrega,
           -- valor = COM IPI (preço oficial da tela de Carteira). Antes era C6_ZPRCVEN,
           -- o que fazia o aging (em atraso/no prazo) divergir da página de Carteira.
           CAST(ROUND(c6.C6_PRCVEN * (1 + (ISNULL(b1.B1_IPI, 0) / 100)), 2) * (c6.C6_QTDVEN - c6.C6_QTDENT) AS DECIMAL(14,2)) valor,
           CAST(ROUND(c6.C6_PRCVEN * (1 + (ISNULL(b1.B1_IPI, 0) / 100)), 2) * (c6.C6_QTDVEN - c6.C6_QTDENT) AS DECIMAL(14,2)) valorIpi,
           COALESCE(NULLIF(RTRIM(bu.X5_DESCRI), ''), RTRIM(c5.C5_ZTIPO)) canal,
           ISNULL(pe.estatus_cod, 0) estatusCod
      FROM SC6010 c6 WITH (NOLOCK)
      JOIN SC5010 c5 WITH (NOLOCK) ON c5.C5_NUM = c6.C6_NUM AND c5.C5_FILIAL = '01' AND c5.D_E_L_E_T_ <> '*'
      JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = c5.C5_CLIENTE AND sa1.A1_LOJA = c5.C5_LOJACLI AND sa1.D_E_L_E_T_ <> '*'
      JOIN SB1010 b1 WITH (NOLOCK) ON b1.B1_FILIAL = '' AND b1.B1_COD = c6.C6_PRODUTO AND b1.D_E_L_E_T_ <> '*'
      LEFT JOIN SX5010 bu WITH (NOLOCK) ON bu.X5_FILIAL = '  ' AND bu.X5_TABELA = 'Z1'
           AND RTRIM(bu.X5_CHAVE) = RTRIM(c5.C5_ZTIPO) AND bu.D_E_L_E_T_ <> '*'
      LEFT JOIN pedidos_estatus pe WITH (NOLOCK) ON pe.c6_filial = c6.C6_FILIAL AND pe.c6_num = c6.C6_NUM
           AND pe.c6_item = c6.C6_ITEM AND pe.c6_produto = c6.C6_PRODUTO
     WHERE c6.D_E_L_E_T_ <> '*' AND c6.C6_FILIAL = '01' AND ${Carteira.filtroSql('c6')}`, {});
}

// Posição de estoque (mesma base do Painel de Estoque de Compras).
async function lerEstoque(Protheus) {
  return Protheus.connectAndQuery(`
    SELECT RTRIM(b2.B2_COD) cod, RTRIM(b2.B2_LOCAL) armazem, b2.B2_QATU saldo, b2.B2_VATU1 valor
      FROM SB2010 b2 WITH (NOLOCK)
     WHERE b2.D_E_L_E_T_ <> '*' AND b2.B2_FILIAL = '01'
       AND EXISTS (SELECT 1 FROM NNR010 nnr WITH (NOLOCK)
                    WHERE nnr.D_E_L_E_T_ <> '*' AND RTRIM(nnr.NNR_CODIGO) = RTRIM(b2.B2_LOCAL))`, {});
}

// Lead time medido no PEDIDO: dias entre a emissão e a data de faturamento do item
// (C6_DATFAT). É a conta do Relatório de Vendas — janela diferente da "idade do
// pedido faturado", que olha pelo lado da nota.
async function lerLeadTimePedido(Protheus, ini, fim) {
  return Protheus.connectAndQuery(`
    SELECT LEFT(c5.C5_EMISSAO, 4) ano,
           DATEDIFF(DAY, CONVERT(date, c5.C5_EMISSAO, 112), CONVERT(date, c6.C6_DATFAT, 112)) dias,
           COUNT(*) n
      FROM SC6010 c6 WITH (NOLOCK)
      JOIN SC5010 c5 WITH (NOLOCK) ON c5.C5_FILIAL = c6.C6_FILIAL AND c5.C5_NUM = c6.C6_NUM AND c5.D_E_L_E_T_ <> '*'
     WHERE c6.D_E_L_E_T_ <> '*' AND c6.C6_FILIAL = '01' AND c5.C5_EMISSAO BETWEEN @ini AND @fim
       AND c6.C6_CF IN (${listaSql(CFOPS_PEDIDO)}) AND c6.C6_BLQ = ' '
       AND RTRIM(c5.C5_ZTIPO) NOT IN ('RED')
       AND LEN(RTRIM(c6.C6_DATFAT)) = 8 AND c6.C6_DATFAT >= c5.C5_EMISSAO
     GROUP BY LEFT(c5.C5_EMISSAO, 4),
              DATEDIFF(DAY, CONVERT(date, c5.C5_EMISSAO, 112), CONVERT(date, c6.C6_DATFAT, 112))`, { ini, fim });
}

module.exports = {
  CFOPS_PEDIDO, CFOPS_NOTA, ANOS, ANO_BASE, NOMES_REGIAO, regiaoDe, famOf, canalOf,
  ETAPA_POR_ESTATUS, hojeBrasilia, ymd, zeros, trim, N, n2,
  lerEntrada, lerFaturamento, lerFaturamentoSku, lerMargem, lerIdadePedido, lerLeadTimePedido, lerDiarios,
  lerCarteira, lerEstoque
};

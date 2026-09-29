// services/shopifyCatalogo.js — o CATÁLOGO que vai para a loja Shopify, lido do Protheus.
//
// Fonte do filtro: ACV010 ("Categoria x Grupo ou Produto"), apoiada na ACU010
// ("Categoria de Produtos"). Um registro da ACV amarra uma categoria a um GRUPO
// INTEIRO (ACV_GRUPO) **ou** a um PRODUTO avulso (ACV_CODPRO) — os dois casos contam,
// por isso o UNION. Preço vem da DA1 (tabela escolhida no .env, padrão 007).
//
// ⚠️ Em 29/09/2026 a ACU010 e a ACV010 estão VAZIAS (0 registros). Enquanto o cadastro
// não for feito no Protheus, este módulo devolve 0 produtos — de propósito, e a tela de
// prévia diz isso em vez de ficar em silêncio.
//
// ⚠️ DESEMPATE DE PREÇO: a DA1 tem produto com mais de uma linha ATIVA na mesma tabela
// (6 casos na 007 — ex.: 000648 com R$ 8,42 de 2019 e R$ 17,92 de 2023, os dois
// ativos). Sem o ROW_NUMBER por DA1_DATVIG a loja recebe o preço de 2019.
//
// Este módulo NÃO filtra o que é inelegível: devolve tudo que a ACV marcou, com as
// flags do diagnóstico (sem preço / bloqueado / obsoleto). Quem consome decide —
// a prévia mostra os problemas, o motor manda só os elegíveis.

const crypto = require('crypto');

const trim = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

const TABELA_PRECO = () => trim(process.env.SHOPIFY_TABELA_PRECO) || '007';
// Filiais aceitas na ACU/ACV. A ACV está vazia, então não dá para saber ainda qual
// filial o cadastro vai usar — aceitamos a compartilhada ('') e a 01 por padrão.
const FILIAIS = () => {
  const v = trim(process.env.SHOPIFY_FILIAIS);
  return (v ? v.split(',') : ['', '01']).map(trim);
};

const SQL_CATALOGO = `
  WITH cat AS (
    SELECT RTRIM(ACU_COD) cod, RTRIM(ACU_DESC) descricao, RTRIM(ISNULL(ACU_CODPAI,'')) pai
      FROM ACU010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*'
       AND RTRIM(ISNULL(ACU_MSBLQL,'')) <> '1'
       AND RTRIM(ISNULL(ACU_FILIAL,'')) IN (SELECT valor FROM @filiais)
  ),
  -- A ACV amarra a categoria a um PRODUTO avulso ou a um GRUPO inteiro.
  sel AS (
    SELECT RTRIM(v.ACV_CATEGO) categoria, RTRIM(v.ACV_CODPRO) cod
      FROM ACV010 v WITH (NOLOCK)
     WHERE v.D_E_L_E_T_ <> '*'
       AND RTRIM(ISNULL(v.ACV_FILIAL,'')) IN (SELECT valor FROM @filiais)
       AND RTRIM(ISNULL(v.ACV_CODPRO,'')) <> ''
    UNION
    SELECT RTRIM(v.ACV_CATEGO) categoria, RTRIM(b.B1_COD) cod
      FROM ACV010 v WITH (NOLOCK)
      JOIN SB1010 b WITH (NOLOCK)
        ON RTRIM(b.B1_GRUPO) = RTRIM(v.ACV_GRUPO) AND b.D_E_L_E_T_ <> '*'
     WHERE v.D_E_L_E_T_ <> '*'
       AND RTRIM(ISNULL(v.ACV_FILIAL,'')) IN (SELECT valor FROM @filiais)
       AND RTRIM(ISNULL(v.ACV_CODPRO,'')) = ''
       AND RTRIM(ISNULL(v.ACV_GRUPO,''))  <> ''
  ),
  -- Uma linha de preço por produto: a de vigência mais recente. Ver nota no topo.
  preco AS (
    SELECT RTRIM(DA1_CODPRO) cod, DA1_PRCVEN preco, RTRIM(ISNULL(DA1_DATVIG,'')) vigencia,
           ROW_NUMBER() OVER (PARTITION BY RTRIM(DA1_CODPRO)
                              ORDER BY RTRIM(ISNULL(DA1_DATVIG,'')) DESC,
                                       RTRIM(ISNULL(DA1_ITEM,'')) DESC) rn
      FROM DA1010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*'
       AND RTRIM(DA1_CODTAB) = @tabela
       AND ISNULL(DA1_PRCVEN, 0) > 0
       AND RTRIM(ISNULL(DA1_ATIVO,'')) <> '2'
  )
  SELECT s.categoria,
         ISNULL(c.descricao, '')            categoria_desc,
         RTRIM(b.B1_COD)                    codigo,
         RTRIM(b.B1_DESC)                   descricao,
         RTRIM(ISNULL(b.B1_TIPO,''))        tipo,
         RTRIM(ISNULL(b.B1_UM,''))          unidade,
         RTRIM(ISNULL(b.B1_GRUPO,''))       grupo,
         RTRIM(ISNULL(b.B1_POSIPI,''))      ncm,
         RTRIM(ISNULL(b.B1_CODBAR,''))      ean,
         ISNULL(b.B1_PESO, 0)               peso,
         RTRIM(ISNULL(b.B1_MSBLQL,''))      bloqueado,
         RTRIM(ISNULL(b.B1_ZOBSOLE,''))     obsoleto,
         RTRIM(ISNULL(b5.B5_CEME,''))       desc_complementar,
         p.preco                            preco,
         ISNULL(p.vigencia, '')             preco_vigencia
    FROM sel s
    JOIN SB1010 b  WITH (NOLOCK) ON RTRIM(b.B1_COD) = s.cod AND b.D_E_L_E_T_ <> '*'
    LEFT JOIN cat  c             ON c.cod = s.categoria
    LEFT JOIN SB5010 b5 WITH (NOLOCK) ON RTRIM(b5.B5_COD) = RTRIM(b.B1_COD) AND b5.D_E_L_E_T_ <> '*'
    LEFT JOIN preco p            ON p.cod = RTRIM(b.B1_COD) AND p.rn = 1`;

// O driver mssql não aceita lista como parâmetro; expandimos as filiais como literais
// seguros (só letras/dígitos passam) em vez de concatenar entrada crua no SQL.
function montarSql() {
  const lista = FILIAIS()
    .filter((f) => /^[A-Za-z0-9]{0,4}$/.test(f))
    .map((f) => `SELECT '${f}' valor`)
    .join(' UNION ALL ');
  const valores = lista || `SELECT '' valor`;
  return SQL_CATALOGO.replace(/@filiais/g, `(${valores}) fil`);
}

// Motivos que impedem um produto marcado na ACV de ir para a loja.
function impedimentos(p) {
  const m = [];
  if (p.bloqueado === '1') m.push('bloqueado no Protheus (B1_MSBLQL)');
  if (p.obsoleto === 'S') m.push('marcado como obsoleto (B1_ZOBSOLE)');
  if (!(p.preco > 0)) m.push(`sem preço ativo na tabela ${TABELA_PRECO()}`);
  if (!p.titulo) m.push('sem descrição no SB1');
  return m;
}

// Gate de atualização: cobre SÓ o que o espelho reescreve num produto que já existe
// na loja — hoje, o preço. O título fica de fora de propósito: ele é usado na criação
// e depois pertence à loja, então mudança de B1_DESC no Protheus não pode disparar
// escrita (seria uma chamada à API que não muda nada e arriscaria mexer no que o
// pessoal ajustou à mão).
function hashProduto(p) {
  return crypto.createHash('sha1')
    .update(`${p.codigo}|${p.preco.toFixed(2)}`)
    .digest('hex').slice(0, 16);
}

function normalizar(row) {
  const p = {
    codigo: trim(row.codigo),
    titulo: trim(row.descricao),
    descComplementar: trim(row.desc_complementar),
    tipo: trim(row.tipo),
    unidade: trim(row.unidade),
    grupo: trim(row.grupo),
    ncm: trim(row.ncm),
    ean: trim(row.ean),
    peso: num(row.peso),
    bloqueado: trim(row.bloqueado),
    obsoleto: trim(row.obsoleto),
    preco: num(row.preco),
    precoVigencia: trim(row.preco_vigencia),
    categorias: []
  };
  p.impedimentos = impedimentos(p);
  p.elegivel = p.impedimentos.length === 0;
  p.ativo = p.elegivel;
  p.hash = hashProduto(p);
  return p;
}

// Carrega o catálogo com 1 LINHA POR SKU. Um produto pode estar em mais de uma
// categoria da ACV; as categorias viram uma lista no próprio produto.
async function carregar(Protheus) {
  const rows = await Protheus.connectAndQuery(montarSql(), { tabela: TABELA_PRECO() });

  const porCodigo = new Map();
  for (const row of rows) {
    const cod = trim(row.codigo);
    if (!cod) continue;
    let p = porCodigo.get(cod);
    if (!p) { p = normalizar(row); porCodigo.set(cod, p); }
    const cat = trim(row.categoria);
    if (cat && !p.categorias.some((c) => c.codigo === cat)) {
      p.categorias.push({ codigo: cat, descricao: trim(row.categoria_desc) });
    }
  }
  return [...porCodigo.values()];
}

// Só o que pode ir para a loja.
const elegiveis = (catalogo) => catalogo.filter((p) => p.elegivel);

// Panorama do cadastro no Protheus, para a tela de prévia acompanhar a carga da
// ACU/ACV enquanto ela é feita.
async function diagnostico(Protheus) {
  const r = (await Protheus.connectAndQuery(`
    SELECT
      (SELECT COUNT(*) FROM ACU010 WITH (NOLOCK) WHERE D_E_L_E_T_ <> '*') categorias,
      (SELECT COUNT(*) FROM ACV010 WITH (NOLOCK) WHERE D_E_L_E_T_ <> '*') vinculos,
      (SELECT COUNT(*) FROM DA1010 WITH (NOLOCK)
        WHERE D_E_L_E_T_ <> '*' AND RTRIM(DA1_CODTAB) = @tabela
          AND ISNULL(DA1_PRCVEN,0) > 0 AND RTRIM(ISNULL(DA1_ATIVO,'')) <> '2') itens_tabela_preco`,
    { tabela: TABELA_PRECO() }))[0] || {};

  return {
    categorias: Number(r.categorias || 0),
    vinculos: Number(r.vinculos || 0),
    itensTabelaPreco: Number(r.itens_tabela_preco || 0),
    tabelaPreco: TABELA_PRECO()
  };
}

// ---------------------------------------------------------------------------
// CANDIDATOS AO CADASTRO DA ACV
//
// `B5_ECFLAG='1'` é a marca NATIVA do Protheus de "produto habilitado para
// e-commerce" — é o mesmo campo que o filtro fechado da TOTVS (`LjxjCsCoPr()`,
// usado pelo adapter EAI MATA010/ITEM) exige. Em 29/09/2026 há 2.063 produtos
// marcados em produção, dos quais 2.013 têm preço na tabela 007.
//
// A ACV foi cadastrada POR PRODUTO (decisão do usuário), o que significa digitar
// um vínculo por SKU. Esta consulta entrega a lista de trabalho pronta: quem já
// está marcado como e-commerce no ERP e ainda NÃO tem vínculo na ACV. Sem isso o
// cadastro vira escolha no braço, com risco de ficar incompleto.
//
// Não é filtro do espelho — o filtro continua sendo a ACV. Isto é só o roteiro.
const SQL_CANDIDATOS = `
  WITH pr AS (
    SELECT RTRIM(DA1_CODPRO) cod, DA1_PRCVEN preco, RTRIM(ISNULL(DA1_DATVIG,'')) vig,
           ROW_NUMBER() OVER (PARTITION BY RTRIM(DA1_CODPRO)
                              ORDER BY RTRIM(ISNULL(DA1_DATVIG,'')) DESC,
                                       RTRIM(ISNULL(DA1_ITEM,'')) DESC) rn
      FROM DA1010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*' AND RTRIM(DA1_CODTAB) = @tabela
       AND ISNULL(DA1_PRCVEN, 0) > 0 AND RTRIM(ISNULL(DA1_ATIVO,'')) <> '2'
  )
  SELECT RTRIM(b.B1_COD)                codigo,
         RTRIM(b.B1_DESC)               descricao,
         RTRIM(ISNULL(b.B1_TIPO,''))    tipo,
         RTRIM(ISNULL(b.B1_GRUPO,''))   grupo,
         RTRIM(ISNULL(b.B1_UM,''))      unidade,
         RTRIM(ISNULL(b.B1_POSIPI,''))  ncm,
         RTRIM(ISNULL(b.B1_CODBAR,''))  ean,
         ISNULL(b.B1_PESO, 0)           peso,
         RTRIM(ISNULL(b.B1_MSBLQL,''))  bloqueado,
         RTRIM(ISNULL(b.B1_ZOBSOLE,'')) obsoleto,
         ''                             desc_complementar,
         pr.preco                       preco,
         ISNULL(pr.vig, '')             preco_vigencia,
         CASE WHEN EXISTS (
           SELECT 1 FROM ACV010 v WITH (NOLOCK)
            WHERE v.D_E_L_E_T_ <> '*' AND RTRIM(v.ACV_CODPRO) = RTRIM(b.B1_COD)
         ) THEN 1 ELSE 0 END            ja_na_acv
    FROM SB5010 b5 WITH (NOLOCK)
    JOIN SB1010 b WITH (NOLOCK) ON RTRIM(b.B1_COD) = RTRIM(b5.B5_COD) AND b.D_E_L_E_T_ <> '*'
    LEFT JOIN pr ON pr.cod = RTRIM(b.B1_COD) AND pr.rn = 1
   WHERE b5.D_E_L_E_T_ <> '*' AND RTRIM(ISNULL(b5.B5_ECFLAG,'')) = '1'
   ORDER BY RTRIM(b.B1_COD)`;

async function candidatos(Protheus) {
  const rows = await Protheus.connectAndQuery(SQL_CANDIDATOS, { tabela: TABELA_PRECO() });
  return rows.map((row) => {
    const p = normalizar(row);
    p.jaNaAcv = Number(row.ja_na_acv) === 1;
    return p;
  });
}

module.exports = { carregar, elegiveis, candidatos, diagnostico, hashProduto, TABELA_PRECO };

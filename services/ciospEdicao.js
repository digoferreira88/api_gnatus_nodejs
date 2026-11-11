// services/ciospEdicao.js — gestão da edição do CIOSP: configuração, importação da
// Tabela Comercial, formas de pagamento e equipe do evento (spec 2026-11-11, seção 4).
//
// Toda alteração que muda o que o app do estande precisa ter offline (preço, forma,
// equipe, mídia) passa por tocarVersao(): é a "versão do pacote" que o app compara
// para saber se baixa de novo.

const VALIDADE_PADRAO = 7;

// Executa SQL com placeholders $1..$n num client de transação (tem .query) ou no pool
// da aplicação (app.services.Pg.pool).
async function q(db, sql, params = []) {
  const runner = typeof db.query === 'function' ? db : db.services.Pg.pool;
  const r = await runner.query(sql, params);
  return r.rows;
}

// ---------------------------------------------------------------- código do Protheus

// Só um código numérico vira produto do Protheus. "5472 + 1134", "CONF COR" e vazio
// ficam sem vínculo — a linha entra normalmente.
function codigoUnico(codigoImpresso) {
  const s = String(codigoImpresso == null ? '' : codigoImpresso).trim();
  return /^\d+$/.test(s) ? s : null;
}

// A tabela imprime "1116"; no SB1 o código pode ter zeros à esquerda (6 dígitos).
function candidatosB1(codigo) {
  const c = String(codigo);
  return [...new Set([c, c.length < 6 ? c.padStart(6, '0') : c])];
}

async function resolverProdutos(app, codigos) {
  const mapa = new Map();
  const unicos = [...new Set((codigos || []).map(codigoUnico).filter(Boolean))];
  if (!unicos.length) return mapa;
  const candidatos = [...new Set(unicos.flatMap(candidatosB1))];
  try {
    const existentes = new Set();
    for (let i = 0; i < candidatos.length; i += 500) {
      const lote = candidatos.slice(i, i + 500);
      const params = Object.fromEntries(lote.map((c, j) => [`c${j}`, c]));
      const rows = await app.services.Protheus.connectAndQuery(
        `SELECT RTRIM(B1_COD) cod FROM SB1010 WITH (NOLOCK)
          WHERE D_E_L_E_T_ <> '*' AND B1_COD IN (${lote.map((_, j) => `@c${j}`).join(',')})`, params);
      rows.forEach(r => existentes.add(String(r.cod).trim()));
    }
    for (const c of unicos) {
      const achado = candidatosB1(c).find(x => existentes.has(x));
      if (achado) mapa.set(c, achado);
    }
  } catch (e) {
    // Protheus fora do ar não impede a importação: a linha só fica sem vínculo.
    console.warn('ciospEdicao.resolverProdutos: Protheus indisponível —', e.message);
  }
  return mapa;
}

// ---------------------------------------------------------------- configuração

async function tocarVersao(db, edicao) {
  const versao = Date.now().toString(36);
  await q(db,
    `INSERT INTO tab_ciosp_meta (edicao, versao_pacote, atualizado_em) VALUES ($1, $2, NOW())
     ON CONFLICT (edicao) DO UPDATE SET versao_pacote = $2, atualizado_em = NOW()`,
    [edicao, versao]);
  return versao;
}

// Sem edição: a ativa. Edição que ainda não tem linha na meta devolve o padrão.
async function getConfig(app, edicao) {
  const rows = edicao
    ? await q(app, `SELECT * FROM tab_ciosp_meta WHERE edicao = $1`, [edicao])
    : await q(app, `SELECT * FROM tab_ciosp_meta WHERE ativa ORDER BY atualizado_em DESC LIMIT 1`);
  const m = rows[0];
  if (!m) {
    return { edicao: edicao || null, ativa: false, desconto_livre_pct: 0,
      validade_orcamento_dias: VALIDADE_PADRAO, versao_pacote: null };
  }
  return {
    edicao: m.edicao,
    ativa: !!m.ativa,
    desconto_livre_pct: Number(m.desconto_livre_pct) || 0,
    validade_orcamento_dias: Number(m.validade_orcamento_dias) || VALIDADE_PADRAO,
    versao_pacote: m.versao_pacote || null
  };
}

// ---------------------------------------------------------------- importação

const COLS_PRECO = [
  'edicao', 'ordem', 'secao', 'grupo', 'tes', 'codigo', 'produto', 'descricao',
  'preco_13_10x', 'preco_13_6x', 'preco_11_10x', 'preco_11_6x',
  'promocao_texto', 'promocao_pct', 'promocao_condicional', 'prazo_fabric', 'importacao_id'
];

// Troca a tabela inteira da edição numa transação: quem consulta o catálogo durante a
// importação vê a tabela velha inteira ou a nova inteira, nunca metade.
async function importarTabela(app, { edicao, linhas, arquivo, usuarioId, produtos }) {
  const mapa = produtos || new Map();
  return app.services.Pg.withTransaction(async (client) => {
    const comProduto = linhas.filter(l => mapa.has(codigoUnico(l.codigo))).length;
    const [imp] = await q(client,
      `INSERT INTO tab_ciosp_preco_importacao (edicao, arquivo, linhas, com_produto, criado_por)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [edicao, arquivo ? String(arquivo).slice(0, 200) : null, linhas.length, comProduto, usuarioId || null]);

    await q(client, `UPDATE tab_ciosp_preco SET ativo = false WHERE edicao = $1 AND ativo`, [edicao]);

    for (let i = 0; i < linhas.length; i += 200) {
      const lote = linhas.slice(i, i + 200);
      const valores = [];
      const tuplas = lote.map((l, j) => {
        const v = [edicao, l.ordem, l.secao, l.grupo, l.tes, l.codigo, mapa.get(codigoUnico(l.codigo)) || null,
          l.descricao, l.preco_13_10x, l.preco_13_6x, l.preco_11_10x, l.preco_11_6x,
          l.promocao_texto, l.promocao_pct, !!l.promocao_condicional, l.prazo_fabric, imp.id];
        valores.push(...v);
        return `(${v.map((_, k) => `$${j * COLS_PRECO.length + k + 1}`).join(',')})`;
      });
      await q(client, `INSERT INTO tab_ciosp_preco (${COLS_PRECO.join(',')}) VALUES ${tuplas.join(',')}`, valores);
    }

    await tocarVersao(client, edicao);
    return { importacaoId: imp.id, linhas: linhas.length, comProduto };
  });
}

module.exports = {
  codigoUnico, candidatosB1, resolverProdutos,
  tocarVersao, getConfig, importarTabela,
  q
};

// services/ciospEdicao.js — gestão da edição do CIOSP: configuração, importação da
// Tabela Comercial, formas de pagamento e equipe do evento (spec 2026-11-11, seção 4).
//
// Toda alteração que muda o que o app do estande precisa ter offline (preço, forma,
// equipe, mídia) passa por tocarVersao(): é a "versão do pacote" que o app compara
// para saber se baixa de novo.

const VALIDADE_PADRAO = 7;

// Executa SQL com placeholders $1..$n no pool da aplicação (app.services.Pg.pool) ou
// num client de transação. O app é reconhecido por ter .services — NÃO por não ter
// .query: o Express também tem app.query.
async function q(db, sql, params = []) {
  const runner = db.services ? db.services.Pg.pool : db;
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
  'promocao_texto', 'promocao_pct', 'promocao_condicional', 'prazo_fabric', 'importacao_id', 'foto_id'
];

// A foto ligada a uma LINHA (consultórios sem código) mora em tab_ciosp_preco.foto_id.
// Reimportar cria linhas novas; a foto passa para a linha nova com a mesma seção, código
// e descrição. As que não acharem par voltam em `perdidas`, para a tela avisar.
const chaveLinha = (l) => [l.secao, l.codigo, l.descricao]
  .map(v => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toUpperCase()).join('|');

function herdarFotos(novas, antigas) {
  const porChave = new Map((antigas || []).filter(a => a.foto_id).map(a => [chaveLinha(a), a]));
  const usadas = new Set();
  const linhas = novas.map(l => {
    const k = chaveLinha(l);
    const a = porChave.get(k);
    if (a) usadas.add(k);
    return { ...l, foto_id: a ? a.foto_id : null };
  });
  const perdidas = [...porChave.entries()].filter(([k]) => !usadas.has(k))
    .map(([, a]) => `${a.secao || '—'} · ${String(a.descricao).slice(0, 60)}`);
  return { linhas, mantidas: usadas.size, perdidas };
}

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

    const antigas = await q(client,
      `SELECT secao, codigo, descricao, foto_id FROM tab_ciosp_preco
        WHERE edicao = $1 AND ativo AND foto_id IS NOT NULL`, [edicao]);
    const fotos = herdarFotos(linhas, antigas);

    await q(client, `UPDATE tab_ciosp_preco SET ativo = false WHERE edicao = $1 AND ativo`, [edicao]);

    for (let i = 0; i < fotos.linhas.length; i += 200) {
      const lote = fotos.linhas.slice(i, i + 200);
      const valores = [];
      const tuplas = lote.map((l, j) => {
        const v = [edicao, l.ordem, l.secao, l.grupo, l.tes, l.codigo, mapa.get(codigoUnico(l.codigo)) || null,
          l.descricao, l.preco_13_10x, l.preco_13_6x, l.preco_11_10x, l.preco_11_6x,
          l.promocao_texto, l.promocao_pct, !!l.promocao_condicional, l.prazo_fabric, imp.id, l.foto_id];
        valores.push(...v);
        return `(${v.map((_, k) => `$${j * COLS_PRECO.length + k + 1}`).join(',')})`;
      });
      await q(client, `INSERT INTO tab_ciosp_preco (${COLS_PRECO.join(',')}) VALUES ${tuplas.join(',')}`, valores);
    }

    await tocarVersao(client, edicao);
    return { importacaoId: imp.id, linhas: linhas.length, comProduto, fotosMantidas: fotos.mantidas, fotosPerdidas: fotos.perdidas };
  });
}

// ---------------------------------------------------------------- formas de pagamento

// As 4 condições impressas na Tabela Comercial. As demais (financeiras, Gnatus Cred,
// boleto, débito) o comercial cadastra por edição.
const FORMAS_PADRAO = [
  { ordem: 1, nome: 'Cartão até 10x', coluna_base: '10x', desconto_pct: 0, parcelas_max: 10 },
  { ordem: 2, nome: 'Cartão até 6x', coluna_base: '6x', desconto_pct: 0, parcelas_max: 6 },
  { ordem: 3, nome: 'Pix — 10%', coluna_base: '10x', desconto_pct: 10, parcelas_max: 1 },
  { ordem: 4, nome: 'Pix — 6%', coluna_base: '6x', desconto_pct: 6, parcelas_max: 1 }
];

const bool = (v) => v === true || ['1', 'true', 'sim', 's'].includes(String(v).toLowerCase());

function validarForma(b) {
  const nome = String(b?.nome || '').trim();
  if (!nome) return { erro: 'Informe o nome da forma de pagamento.' };
  if (nome.length > 60) return { erro: 'O nome passa de 60 caracteres.' };
  const coluna = String(b.coluna_base || '').trim().toLowerCase();
  if (!['10x', '6x'].includes(coluna)) return { erro: 'Coluna-base deve ser 10x ou 6x.' };
  const desconto = Number(b.desconto_pct ?? 0);
  if (!Number.isFinite(desconto) || desconto < 0 || desconto >= 100) {
    return { erro: 'O desconto deve ficar entre 0 e 99,99%.' };
  }
  const parcelas = Number(b.parcelas_max ?? 1);
  if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > 24) {
    return { erro: 'Parcelas deve ser um número inteiro de 1 a 24.' };
  }
  return {
    forma: {
      nome, coluna_base: coluna, desconto_pct: Math.round(desconto * 100) / 100, parcelas_max: parcelas,
      exige_credito: bool(b.exige_credito), financeira: bool(b.financeira),
      ativo: b.ativo === undefined ? true : bool(b.ativo), ordem: Number.isInteger(Number(b.ordem)) ? Number(b.ordem) : 0
    }
  };
}

// Só semeia edição SEM nenhuma forma: semear sempre recriaria a forma que o comercial
// excluiu ou renomeou a cada vez que alguém salva a configuração.
async function semearFormas(db, edicao) {
  const [{ n }] = await q(db, `SELECT COUNT(*)::int AS n FROM tab_ciosp_forma_pagto WHERE edicao = $1`, [edicao]);
  if (Number(n) > 0) return;
  for (const f of FORMAS_PADRAO) {
    await q(db,
      `INSERT INTO tab_ciosp_forma_pagto (edicao, ordem, nome, coluna_base, desconto_pct, parcelas_max)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (edicao, nome) DO NOTHING`,
      [edicao, f.ordem, f.nome, f.coluna_base, f.desconto_pct, f.parcelas_max]);
  }
}

// ---------------------------------------------------------------- equipe do evento

const CATEGORIAS = ['EQUIPAMENTOS', 'DIGITAL', 'AT'];

function validarMembro(b) {
  const usuarioId = Number(b?.usuario_id);
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) return { erro: 'Escolha o usuário da intranet.' };
  const nome = String(b.nome_exibicao || '').trim();
  if (!nome) return { erro: 'Informe o nome que aparece no painel.' };
  if (nome.length > 120) return { erro: 'O nome passa de 120 caracteres.' };
  const papel = String(b.papel || '').trim().toLowerCase();
  if (!['vendedor', 'gerente'].includes(papel)) return { erro: 'O papel deve ser vendedor ou gerente.' };
  const categoria = String(b.categoria || '').trim().toUpperCase() || null;
  if (categoria && !CATEGORIAS.includes(categoria)) return { erro: 'A categoria deve ser EQUIPAMENTOS, DIGITAL ou AT.' };
  if (papel === 'vendedor' && !categoria) return { erro: 'O vendedor precisa de uma categoria.' };
  const gerenteId = b.gerente_id == null || b.gerente_id === '' ? null : Number(b.gerente_id);
  if (papel === 'vendedor' && !gerenteId) return { erro: 'O vendedor precisa de gerente.' };
  if (gerenteId && gerenteId === usuarioId) return { erro: 'Ninguém é gerente de si mesmo.' };
  const equipe = String(b.equipe || '').trim() || null;
  if (equipe && equipe.length > 120) return { erro: 'A equipe passa de 120 caracteres.' };
  return {
    membro: {
      usuario_id: usuarioId, nome_exibicao: nome, papel, gerente_id: gerenteId,
      categoria, equipe, ativo: b.ativo === undefined ? true : bool(b.ativo)
    }
  };
}

module.exports = {
  codigoUnico, candidatosB1, resolverProdutos, herdarFotos,
  tocarVersao, getConfig, importarTabela,
  FORMAS_PADRAO, validarForma, semearFormas,
  CATEGORIAS, validarMembro,
  q
};

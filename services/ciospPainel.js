// services/ciospPainel.js — o pedido do CIOSP alimenta sozinho o painel de vendas
// (tab_ciosp_venda), sem ninguém digitar a venda de novo (spec 2026-11-11, seção 6.3).
//
// Regra única, aplicada depois de QUALQUER ação no pedido (sincronizarPainel):
//   - conferido  → existe uma linha "Pendente";
//   - finalizado → a mesma linha, "Ok";
//   - qualquer outra situação (devolvido, cancelado…) → a linha não existe.
// Assim o painel nunca diverge do pedido, seja qual for o caminho percorrido.

const { q } = require('./ciospEdicao');

// A VPS roda em UTC: uma venda enviada às 22h de Brasília já é "amanhã" em UTC.
const FMT_DIA = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
});
const dataBrasil = (d) => (d ? FMT_DIA.format(new Date(d)) : null);

const limpar = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const corta = (v, max) => { const s = limpar(v); return s ? s.slice(0, max) : null; };

// "CONSULTÓRIO GNATUS G2 COMPOSTO DE CADEIRA, EQUIPO…" → até 40 caracteres, sem
// partir palavra.
function curta(descricao) {
  const s = limpar(descricao);
  if (s.length <= 40) return s;
  if (s[40] === ' ') return s.slice(0, 40).trim();
  const corte = s.slice(0, 40);
  const espaco = corte.lastIndexOf(' ');
  return (espaco > 0 ? corte.slice(0, espaco) : corte).trim();
}

// Mesmo formato que o comercial usava na planilha: "G1 SF × 1 + Kit BV × 2".
function resumoItens(itens) {
  const texto = (itens || [])
    .map(i => `${curta(i.descricao)} × ${String(Number(i.quantidade) || 0)}`)
    .join(' + ');
  return texto.length > 300 ? texto.slice(0, 299) + '…' : texto;
}

function linhaPainel(pedido, { membro, gerenteNome, forma, itens } = {}) {
  const categoria = pedido.painel_categoria || (membro && membro.categoria) || null;
  if (!categoria) return { erro: 'Defina a categoria do painel: o vendedor não está na equipe do evento.' };

  const parcelas = Number(pedido.parcelas) || 0;
  const tabela = Number(pedido.tabela_comissao);
  const observacao = `Pedido CIOSP nº ${pedido.numero}` +
    (limpar(pedido.protheus_pedido) ? ` · Protheus ${limpar(pedido.protheus_pedido)}` : '');

  return {
    linha: {
      edicao: pedido.edicao,
      categoria,
      cliente: corta(pedido.cliente_nome, 200) || '',
      cpf_cnpj: corta(pedido.cliente_doc, 24),
      data_venda: dataBrasil(pedido.enviado_em),
      vendedor: corta((membro && membro.nome_exibicao) || pedido.vendedor_nome, 120),
      uf: corta(pedido.entrega_uf || pedido.cliente_uf, 4)?.toUpperCase() || null,
      pagto_princ: corta((forma && forma.nome) || pedido.cond_pagto, 60),
      pagto_compl: parcelas > 0 ? `${parcelas}x` : null,
      financiadora: forma && forma.financeira ? corta(forma.nome, 80) : null,
      situacao_fin: pedido.situacao === 'finalizado' ? 'Ok' : 'Pendente',
      gerente: corta(pedido.painel_gerente || gerenteNome, 120),
      origem: pedido.origem || 'Presencial',
      equipe: corta(pedido.painel_equipe || (membro && membro.equipe), 120),
      valor: Math.round(Number(pedido.total || 0) * 100) / 100,
      tabela: tabela === 13 || tabela === 11 ? `${tabela}%` : null,
      equipamentos: resumoItens(itens) || null,
      observacao: observacao.slice(0, 300),
      pedido_id: pedido.id
    }
  };
}

// O que linhaPainel precisa e não está no pedido: o vendedor na equipe do evento, o
// nome do gerente dele, a forma de pagamento e os itens.
async function contextoPainel(db, pedido) {
  let membro = null, gerenteNome = null, forma = null;
  if (pedido.vendedor_id) {
    const m = await q(db,
      `SELECT nome_exibicao, categoria, equipe, gerente_id FROM tab_ciosp_equipe
        WHERE edicao = $1 AND usuario_id = $2 AND ativo LIMIT 1`, [pedido.edicao, pedido.vendedor_id]);
    membro = m[0] || null;
  }
  if (membro && membro.gerente_id) {
    const g = await q(db,
      `SELECT COALESCE(
          (SELECT nome_exibicao FROM tab_ciosp_equipe WHERE edicao = $1 AND usuario_id = $2 LIMIT 1),
          (SELECT nome FROM tab_intranet_usr WHERE id = $2)) AS nome`, [pedido.edicao, membro.gerente_id]);
    gerenteNome = (g[0] && g[0].nome) || null;
  }
  if (pedido.forma_pagto_id) {
    const f = await q(db,
      `SELECT id, edicao, nome, coluna_base, desconto_pct, parcelas_max, exige_credito, financeira, ativo
         FROM tab_ciosp_forma_pagto WHERE id = $1`, [pedido.forma_pagto_id]);
    forma = f[0] || null;
  }
  const itens = await q(db,
    `SELECT descricao, quantidade FROM tab_ciosp_pedido_item WHERE pedido_id = $1 ORDER BY seq`, [pedido.id]);
  return { membro, gerenteNome, forma, itens };
}

const COLUNAS = ['edicao', 'categoria', 'cliente', 'cpf_cnpj', 'data_venda', 'vendedor', 'uf', 'pagto_princ',
  'pagto_compl', 'financiadora', 'situacao_fin', 'gerente', 'origem', 'equipe', 'valor', 'tabela',
  'equipamentos', 'observacao', 'pedido_id'];

// Deixa a linha do painel coerente com a situação do pedido. Rodar na MESMA
// transação da ação: se a linha não fecha, a ação inteira é desfeita.
async function sincronizarPainel(db, pedidoId) {
  const r = await q(db, `SELECT * FROM tab_ciosp_pedido WHERE id = $1`, [pedidoId]);
  const pedido = r[0];
  if (!pedido) throw new Error(`Pedido ${pedidoId} não encontrado.`);

  if (!['conferido', 'finalizado'].includes(pedido.situacao)) {
    await q(db, `DELETE FROM tab_ciosp_venda WHERE pedido_id = $1`, [pedidoId]);
    if (pedido.venda_id != null) await q(db, `UPDATE tab_ciosp_pedido SET venda_id = NULL WHERE id = $1`, [pedidoId]);
    return { venda_id: null, situacao_fin: null };
  }

  const montado = linhaPainel(pedido, await contextoPainel(db, pedido));
  if (montado.erro) throw new Error(montado.erro);
  const l = montado.linha;

  const valores = COLUNAS.map(c => l[c]);
  const ins = await q(db,
    `INSERT INTO tab_ciosp_venda (${COLUNAS.join(', ')})
     VALUES (${COLUNAS.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (pedido_id) WHERE pedido_id IS NOT NULL DO UPDATE SET
       ${COLUNAS.filter(c => c !== 'pedido_id').map(c => `${c} = EXCLUDED.${c}`).join(', ')},
       atualizado_em = NOW()
     RETURNING id`, valores);
  const vendaId = ins[0].id;
  if (Number(pedido.venda_id) !== Number(vendaId)) {
    await q(db, `UPDATE tab_ciosp_pedido SET venda_id = $2 WHERE id = $1`, [pedidoId, vendaId]);
  }
  return { venda_id: vendaId, situacao_fin: l.situacao_fin };
}

module.exports = { dataBrasil, resumoItens, linhaPainel, contextoPainel, sincronizarPainel };

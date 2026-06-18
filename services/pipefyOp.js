// services/pipefyOp.js — Integracao OP -> Pipefy DENTRO da intranet.
// Substitui o script PHP da maquina local:
//   1. Le MURO.dbo.PIPEFYOP (SQL Server, ja acessivel pela conexao Protheus)
//      filtrando pelos produtos geridos em tab_op_pipefy_produtos;
//   2. Mantem estado em tab_op_pipefy_ops (1 linha por OP+serie);
//   3. Garante o produto na TABELA de produtos do Pipefy (registro -> id usado
//      no campo conector do card);
//   4. Cria/atualiza o card no pipe via GraphQL.
//
// Config (.env): PIPEFY_TOKEN (obrigatorio p/ ligar), PIPEFY_PIPE_ID,
// PIPEFY_ORG_ID, PIPEFY_TABELA_PRODUTOS (id da tabela de produtos no Pipefy).
// Sem token -> disponivel() false e o job do scheduler nao roda.
//
// Campos do card (ids do start form, herdados do script PHP):
//   n_mero_de_op_protheus | produto (conector) | n_meros_de_s_rie |
//   data_in_cio | data_do_t_rmino_1   (datas em YYYY/MM/DD, como o PHP enviava)

const TOKEN = () => String(process.env.PIPEFY_TOKEN || '').trim();
const PIPE_ID = () => String(process.env.PIPEFY_PIPE_ID || '304059336').trim();
const ORG_ID = () => String(process.env.PIPEFY_ORG_ID || '301239355').trim();
const TABELA_PRODUTOS = () => String(process.env.PIPEFY_TABELA_PRODUTOS || '').trim();
const DIAS_JANELA = 3;   // mesmo "data_base = hoje - 3" do PHP

const trim = (v) => String(v == null ? '' : v).trim();
const disponivel = () => !!TOKEN();

// ---------- GraphQL ----------
async function gql(query, variables) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch('https://api.pipefy.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN()}` },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.errors) {
      const msg = j.errors ? j.errors.map(e => e.message).join('; ') : `HTTP ${r.status}`;
      throw new Error(`Pipefy: ${msg}`);
    }
    return j.data;
  } catch (e) { clearTimeout(timer); throw e; }
}

// Lista as tabelas da organizacao (p/ descobrir o id da tabela de produtos)
async function listarTabelas() {
  const d = await gql(`query($org: ID!) { organization(id: $org) {
    tables { edges { node { id name table_records_count } } } } }`, { org: ORG_ID() });
  return (d.organization?.tables?.edges || []).map(e => ({
    id: e.node.id, nome: e.node.name, registros: e.node.table_records_count
  }));
}

// Busca (SOMENTE LEITURA) o registro do produto na tabela do Pipefy pelo código.
// NUNCA cria registro: só os produtos cadastrados manualmente (com as instruções)
// são válidos. Devolve o record id, ou null se não houver cadastro.
async function buscarProdutoPipefy(codigo) {
  const tableId = TABELA_PRODUTOS();
  if (!tableId) throw new Error('PIPEFY_TABELA_PRODUTOS não configurado (use o botão "Tabelas Pipefy" pra descobrir o id).');
  const cod = trim(codigo);
  if (!cod) return null;

  const achados = [];
  let after = null;
  do {
    const d = await gql(`query($id: ID!, $a: String) {
      table_records(table_id: $id, first: 50, after: $a) {
        pageInfo { hasNextPage endCursor }
        edges { node { id record_fields { name value } } } } }`, { id: tableId, a: after });
    for (const e of (d.table_records?.edges || [])) {
      const f = e.node.record_fields.find(x => /c.?digo/i.test(x.name));
      if (f && trim(f.value) === cod) {
        achados.push({ id: trim(e.node.id), preenchidos: e.node.record_fields.filter(x => trim(x.value)).length });
      }
    }
    after = d.table_records?.pageInfo?.hasNextPage ? d.table_records.pageInfo.endCursor : null;
  } while (after);

  if (!achados.length) return null;
  // se houver duplicados, fica com o registro mais completo (mais campos preenchidos)
  achados.sort((a, b) => b.preenchidos - a.preenchidos);
  return achados[0].id;
}

// Resolve o record id do produto na tabela do Pipefy (lookup, nunca insert).
async function garantirProdutoPipefy(Pg, produto) {
  if (trim(produto.id_pipefy)) return trim(produto.id_pipefy);
  const recId = await buscarProdutoPipefy(produto.codigo);
  if (!recId) {
    throw new Error(`Produto ${trim(produto.codigo)} não cadastrado na tabela "PRODUTO ACABADO" do Pipefy — OP ignorada (sem insert).`);
  }
  await Pg.connectAndQuery(`UPDATE tab_op_pipefy_produtos SET id_pipefy=@id WHERE codigo=@cod`, { id: recId, cod: trim(produto.codigo) });
  return recId;
}

// 'dd/mm/yyyy' (PIPEFYOP) -> Date | null
function parseDataBR(s) {
  s = trim(s).replace(/-/g, '/');
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return isNaN(d) ? null : d;
}
const isoDate = (d) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;
// formato que o PHP enviava ao Pipefy: YYYY/MM/DD
const pipefyDate = (iso) => iso ? String(iso).slice(0, 10).replace(/-/g, '/') : '';

function montarCampos(opRow, idProdutoPipefy) {
  return [
    { field_id: 'n_mero_de_op_protheus', field_value: opRow.op },
    { field_id: 'produto', field_value: [idProdutoPipefy] },
    { field_id: 'n_meros_de_s_rie', field_value: opRow.numserie },
    { field_id: 'data_in_cio', field_value: pipefyDate(opRow.inicio) },
    { field_id: 'data_do_t_rmino_1', field_value: pipefyDate(opRow.fim) }
  ];
}

async function criarCard(opRow, idProdutoPipefy) {
  const d = await gql(`mutation($input: CreateCardInput!) {
    createCard(input: $input) { card { id } } }`,
    { input: { pipe_id: PIPE_ID(), fields_attributes: montarCampos(opRow, idProdutoPipefy) } });
  return trim(d.createCard?.card?.id);
}

async function atualizarCard(cardId, opRow, idProdutoPipefy) {
  for (const f of montarCampos(opRow, idProdutoPipefy)) {
    await gql(`mutation($input: UpdateCardFieldInput!) {
      updateCardField(input: $input) { success } }`,
      { input: { card_id: cardId, field_id: f.field_id, new_value: f.field_value } });
  }
}

// ---------- Sincronizacao principal ----------
async function sincronizar({ Pg, Protheus }, origem = 'CRON') {
  const resumo = { origem, opsVistas: 0, cardsCriados: 0, cardsAtualizados: 0, erros: 0, detalhes: [] };
  const logar = async () => {
    try {
      await Pg.connectAndQuery(
        `INSERT INTO tab_op_pipefy_log (origem, ops_vistas, cards_criados, cards_atualizados, erros, detalhe)
         VALUES (@o, @v, @c, @a, @e, @d)`,
        { o: origem, v: resumo.opsVistas, c: resumo.cardsCriados, a: resumo.cardsAtualizados,
          e: resumo.erros, d: resumo.detalhes.slice(0, 20).join(' | ').slice(0, 1900) });
    } catch (e) { console.warn('[pipefy-op] log:', e.message); }
  };

  if (!disponivel()) { resumo.detalhes.push('PIPEFY_TOKEN não configurado — nada feito.'); await logar(); return resumo; }

  // 1) Produtos monitorados
  const produtos = await Pg.connectAndQuery(
    `SELECT codigo, descricao, id_pipefy FROM tab_op_pipefy_produtos WHERE ativo = true`, {});
  if (!produtos.length) { resumo.detalhes.push('Lista de produtos vazia — nada a monitorar.'); await logar(); return resumo; }
  const inProdutos = produtos.map(p => `'${trim(p.codigo).replace(/'/g, "''")}'`).join(',');

  // 2) OPs da view (janela: inicio > hoje - DIAS_JANELA, como o PHP)
  const rows = await Protheus.connectAndQuery(
    `SELECT RTRIM(OP) op, RTRIM(PRODUTO) produto, RTRIM(DESCRICAO) descricao,
            RTRIM(NUMSERIE) numserie, RTRIM(INICIO) inicio, RTRIM(FIM) fim
       FROM MURO.dbo.PIPEFYOP WHERE RTRIM(PRODUTO) IN (${inProdutos})`, {});
  const corte = new Date(); corte.setDate(corte.getDate() - DIAS_JANELA); corte.setHours(0, 0, 0, 0);

  for (const r of rows) {
    const inicio = parseDataBR(r.inicio);
    if (!inicio || inicio <= corte) continue;
    resumo.opsVistas++;
    const opRow = {
      op: trim(r.op), produto: trim(r.produto), descricao: trim(r.descricao),
      numserie: trim(r.numserie) || '1', inicio: isoDate(inicio), fim: isoDate(parseDataBR(r.fim))
    };

    try {
      // 3) Upsert do estado
      const estado = (await Pg.connectAndQuery(
        `INSERT INTO tab_op_pipefy_ops (op, numserie, produto, descricao, inicio, fim)
         VALUES (@op, @ns, @prod, @desc, @ini::date, @fim::date)
         ON CONFLICT (op, numserie) DO UPDATE SET
           produto=@prod, descricao=@desc, inicio=@ini::date, fim=@fim::date, atualizado_em=NOW()
         RETURNING id, id_pipefy`,
        { op: opRow.op, ns: opRow.numserie, prod: opRow.produto, desc: opRow.descricao, ini: opRow.inicio, fim: opRow.fim }))[0];

      // 4) Produto na tabela Pipefy
      const prod = produtos.find(p => trim(p.codigo) === opRow.produto);
      const idProdutoPipefy = await garantirProdutoPipefy(Pg, { ...prod, codigo: opRow.produto, descricao: opRow.descricao });
      if (prod && !trim(prod.id_pipefy)) prod.id_pipefy = idProdutoPipefy;

      // 5) Card
      if (!trim(estado.id_pipefy)) {
        const cardId = await criarCard(opRow, idProdutoPipefy);
        await Pg.connectAndQuery(`UPDATE tab_op_pipefy_ops SET id_pipefy=@c, erro=NULL, atualizado_em=NOW() WHERE id=@id`, { c: cardId, id: estado.id });
        resumo.cardsCriados++;
      } else {
        await atualizarCard(trim(estado.id_pipefy), opRow, idProdutoPipefy);
        await Pg.connectAndQuery(`UPDATE tab_op_pipefy_ops SET erro=NULL, atualizado_em=NOW() WHERE id=@id`, { id: estado.id });
        resumo.cardsAtualizados++;
      }
    } catch (e) {
      resumo.erros++;
      resumo.detalhes.push(`OP ${opRow.op}/${opRow.numserie}: ${e.message}`);
      try {
        await Pg.connectAndQuery(
          `UPDATE tab_op_pipefy_ops SET erro=@e, atualizado_em=NOW() WHERE op=@op AND numserie=@ns`,
          { e: String(e.message).slice(0, 400), op: opRow.op, ns: opRow.numserie });
      } catch (e2) { /* best-effort */ }
    }
  }

  await logar();
  console.log(`[pipefy-op] ${origem}: vistas=${resumo.opsVistas} criados=${resumo.cardsCriados} atualizados=${resumo.cardsAtualizados} erros=${resumo.erros}`);
  return resumo;
}

module.exports = { disponivel, sincronizar, listarTabelas, PIPE_ID, ORG_ID, TABELA_PRODUTOS };

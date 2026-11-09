// Filtro ESCONDIDO de cobranca (checkbox cego da operadora) — regra unica usada
// pelo dashboard e pelo Faturamento x Inadimplencia.
//
// A gestora flaga SUB-STATUS a EXCLUIR (tab_cobranca_filtro_status). Desde
// 09/11/2026 vale SO o sub-status do TITULO (tab_cobranca_status_titulo):
//   - titulo com sub-status excluido some;
//   - titulo sem sub-status proprio NAO herda mais o status do cliente (decisao
//     do usuario: o status do cliente virou Recuperavel / Nao recuperavel, e os
//     titulos sem sub-status voltam a aparecer ate a equipe marca-los).
//
// Faturamento (SF2) nao tem titulo: antes saia pelo status do CLIENTE; com o
// status do cliente fora da regra, o faturamento nao e mais filtrado
// (clienteSql devolve vazio — mantido para os chamadores).

const trim = (v) => String(v == null ? '' : v).trim();
// Valores entram literais no SQL (lista grande demais p/ parametro): so alfanumerico.
const san = (v) => trim(v).replace(/[^A-Za-z0-9]/g, '');

const chaveTitulo = (cod, loja, prefixo, num, parcela, tipo) =>
  [cod, loja, prefixo, num, parcela, tipo].map(san).join('|');

const VAZIO = {
  ativo: false,
  excluiTitulo: () => false,
  se1Sql: () => '',
  clienteSql: () => ''
};

async function montar({ Pg }) {
  const cfgRows = await Pg.connectAndQuery(
    `SELECT status_excluidos FROM tab_cobranca_filtro_status WHERE id = 1`, {});
  let ex = cfgRows[0] && cfgRows[0].status_excluidos;
  if (typeof ex === 'string') { try { ex = JSON.parse(ex); } catch { ex = []; } }
  const setEx = new Set(Array.isArray(ex) ? ex.map(trim) : []);
  if (!setEx.size) return VAZIO;

  const titRows = await Pg.connectAndQuery(
    `SELECT cliente_cod, cliente_loja, titulo_prefixo, titulo_num, titulo_parcela, titulo_tipo, status
       FROM tab_cobranca_status_titulo`, {});

  const titExcluir = new Set();      // titulo com sub-status excluido
  titRows.forEach(s => {
    if (setEx.has(trim(s.status))) {
      titExcluir.add(chaveTitulo(s.cliente_cod, s.cliente_loja, s.titulo_prefixo, s.titulo_num, s.titulo_parcela, s.titulo_tipo));
    }
  });

  const excluiTitulo = (cod, loja, prefixo, num, parcela, tipo) =>
    titExcluir.has(chaveTitulo(cod, loja, prefixo, num, parcela, tipo));

  const lista = (set) => [...set].map(k => `'${k}'`).join(',');

  // Fragmento p/ queries na SE1: mesma regra do excluiTitulo.
  const se1Sql = (a = 'se1') => {
    if (!titExcluir.size) return '';
    const kTit = `RTRIM(${a}.E1_CLIENTE) + '|' + RTRIM(${a}.E1_LOJA) + '|' + RTRIM(${a}.E1_PREFIXO)`
      + ` + '|' + RTRIM(${a}.E1_NUM) + '|' + RTRIM(${a}.E1_PARCELA) + '|' + RTRIM(${a}.E1_TIPO)`;
    return ` AND ${kTit} NOT IN (${lista(titExcluir)})`;
  };

  return { ativo: true, excluiTitulo, se1Sql, clienteSql: () => '' };
}

module.exports = { montar, VAZIO };

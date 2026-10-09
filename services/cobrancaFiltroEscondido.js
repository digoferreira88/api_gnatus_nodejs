// Filtro ESCONDIDO de cobranca (checkbox cego da operadora) — regra unica usada
// pelo dashboard e pelo Faturamento x Inadimplencia.
//
// A gestora flaga status a EXCLUIR (tab_cobranca_filtro_status). O status que vale
// para cada TITULO e o status EFETIVO:
//   - o status proprio do titulo (tab_cobranca_status_titulo), quando existe;
//   - senao, o status do cliente (tab_cobranca_status_cliente).
// Assim um titulo em JURIDICO some mesmo que o cliente esteja "Em cobranca", e um
// titulo marcado como NEGOCIANDO continua aparecendo mesmo que o cliente esteja
// em JURIDICO.
//
// Faturamento (SF2) nao tem titulo: la a exclusao segue pelo status do CLIENTE
// (o vinculo NF -> titulo por F2_PREFIXO/F2_DUPL so fecha para ~20% dos titulos
// em aberto; os demais sao de pedido, prefixo PED).

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

  const [cliRows, titRows] = await Promise.all([
    Pg.connectAndQuery(`SELECT cliente_cod, cliente_loja, status FROM tab_cobranca_status_cliente`, {}),
    Pg.connectAndQuery(
      `SELECT cliente_cod, cliente_loja, titulo_prefixo, titulo_num, titulo_parcela, titulo_tipo, status
         FROM tab_cobranca_status_titulo`, {})
  ]);

  const clientes = new Set();        // "cod|loja" com status de cliente excluido
  cliRows.forEach(s => {
    if (setEx.has(trim(s.status))) clientes.add(`${san(s.cliente_cod)}|${san(s.cliente_loja)}`);
  });
  const titExcluir = new Set();      // titulo com status proprio excluido
  const titManter  = new Set();      // titulo com status proprio NAO excluido (vence o do cliente)
  titRows.forEach(s => {
    const k = chaveTitulo(s.cliente_cod, s.cliente_loja, s.titulo_prefixo, s.titulo_num, s.titulo_parcela, s.titulo_tipo);
    (setEx.has(trim(s.status)) ? titExcluir : titManter).add(k);
  });

  const excluiTitulo = (cod, loja, prefixo, num, parcela, tipo) => {
    const k = chaveTitulo(cod, loja, prefixo, num, parcela, tipo);
    if (titExcluir.has(k)) return true;
    if (titManter.has(k)) return false;
    return clientes.has(`${san(cod)}|${san(loja)}`);
  };

  const lista = (set) => [...set].map(k => `'${k}'`).join(',');
  const clienteSql = (colCli, colLoja) => clientes.size
    ? ` AND (RTRIM(${colCli}) + '|' + RTRIM(${colLoja})) NOT IN (${lista(clientes)})`
    : '';

  // Fragmento p/ queries na SE1: mesma precedencia do excluiTitulo.
  const se1Sql = (a = 'se1') => {
    if (!clientes.size && !titExcluir.size) return '';
    const kCli = `RTRIM(${a}.E1_CLIENTE) + '|' + RTRIM(${a}.E1_LOJA)`;
    const kTit = `${kCli} + '|' + RTRIM(${a}.E1_PREFIXO) + '|' + RTRIM(${a}.E1_NUM)`
      + ` + '|' + RTRIM(${a}.E1_PARCELA) + '|' + RTRIM(${a}.E1_TIPO)`;
    const conds = [];
    if (titExcluir.size) conds.push(`${kTit} IN (${lista(titExcluir)})`);
    if (clientes.size) {
      conds.push(titManter.size
        ? `(${kCli} IN (${lista(clientes)}) AND ${kTit} NOT IN (${lista(titManter)}))`
        : `${kCli} IN (${lista(clientes)})`);
    }
    return ` AND NOT (${conds.join(' OR ')})`;
  };

  return { ativo: true, excluiTitulo, se1Sql, clienteSql };
}

module.exports = { montar, VAZIO };

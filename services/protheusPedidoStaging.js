// services/protheusPedidoStaging.js — grava pedido na staging MURO.dbo.SZ6010 e lê
// de volta o número gerado pelo Protheus.
//
// ⚠️ ESCRITA NO PROTHEUS — a 4ª exceção à regra de só-leitura da intranet (as outras
// são reserva de estoque, carteira do borderô e previsão de entrega do PC). É uma
// tabela de STAGING, não um documento: quem cria o pedido de venda é a rotina ADVPL
// do lado do ERP. Ainda assim, gravar aqui DISPARA criação de pedido de verdade.
//
// O caminho é o mesmo do portal B2B antigo (app/admin/exporting.php), vivo desde
// 2023 com 11.006 pedidos. Contrato de 14 campos, um registro POR ITEM.
//
// A base MURO é separada da PROTHEUS, mas está no mesmo SQL Server — a conexão
// padrão da intranet alcança as duas por referência cross-database (testado).
//
// O que a rotina ADVPL do outro lado faz sozinha (medido cruzando SZ6010 × SC6010,
// não presumido):
//   - resolve o CLIENTE pelo CNPJ (Z6_CLICOD vem vazio na maioria dos registros);
//   - atribui a TES (531 no caso dominante, 530, 588/589 de SUFRAMA) — nós NUNCA
//     mandamos TES;
//   - cria pedido NORMAL (C5_TIPO='N'), nunca triangular;
//   - devolve o número do pedido em Z6_NUM.

const TABELA = 'MURO.dbo.SZ6010';

const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Z6_IDPORTAL é int (teto 2.147.483.647). O id de pedido do Shopify tem 13 dígitos e
// NÃO cabe — por isso a chave é o order_number (o #1001 que o cliente vê).
const LIMITE_INT = 2147483647;

// ⚠️ Documento zerado NÃO é "ausente": a SA1 tem 8.699 clientes com CGC vazio, 10 com
// '00000000000' e 1 com '00000000000000'. Um CNPJ de zeros casa com um cliente REAL
// (testado: resolveu para um cadastro de verdade). Pedido com documento inválido iria
// para o cliente errado, em silêncio. Conferir dígito verificador é barato e fecha a porta.
function digitosValidos(d) {
  if (/^(\d)\1+$/.test(d)) return false;           // todos iguais (inclui só zeros)
  if (d.length === 11) {                            // CPF
    const calc = (ate) => {
      let s = 0;
      for (let i = 0; i < ate; i++) s += Number(d[i]) * (ate + 1 - i);
      const r = (s * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
  }
  if (d.length === 14) {                            // CNPJ
    const calc = (ate) => {
      const pesos = ate === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
      let s = 0;
      for (let i = 0; i < ate; i++) s += Number(d[i]) * pesos[i];
      const r = s % 11;
      return r < 2 ? 0 : 11 - r;
    };
    return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
  }
  return false;
}

function validarItem(it, i) {
  const erros = [];
  if (!trim(it.produto)) erros.push(`item ${i + 1}: produto vazio`);
  if (trim(it.produto).length > 15) erros.push(`item ${i + 1}: produto "${it.produto}" passa de 15 caracteres`);
  if (!(num(it.quantidade) > 0)) erros.push(`item ${i + 1}: quantidade inválida`);
  if (!(num(it.preco) > 0)) erros.push(`item ${i + 1}: preço inválido`);
  return erros;
}

// Confere o pedido inteiro ANTES de escrever qualquer linha. A staging não tem
// transação com a rotina do ERP: meio pedido gravado vira meio pedido no Protheus.
function validar(pedido) {
  const erros = [];
  const id = num(pedido.orderNumber);
  if (!Number.isInteger(id) || id <= 0) erros.push('orderNumber precisa ser inteiro positivo');
  if (id > LIMITE_INT) erros.push(`orderNumber ${id} não cabe no Z6_IDPORTAL (int)`);

  const cnpj = soDig(pedido.cnpj);
  if (!cnpj) erros.push('CNPJ ausente — é por ele que o ERP resolve o cliente');
  else if (cnpj.length !== 14 && cnpj.length !== 11) erros.push(`CNPJ/CPF com ${cnpj.length} dígitos`);
  else if (!digitosValidos(cnpj)) erros.push(`CNPJ/CPF ${cnpj} inválido (dígito verificador) — documento zerado casa com cliente real na SA1`);

  if (trim(pedido.condPag).length > 3) erros.push('condPag passa de 3 caracteres (Z6_COND)');
  if (trim(pedido.formaPag).length > 1) erros.push('formaPag passa de 1 caractere (Z6_FORMAPG)');
  if (trim(pedido.tabelaPreco).length > 10) erros.push('tabelaPreco passa de 10 caracteres');
  if (trim(pedido.transportadora).length > 6) erros.push('transportadora passa de 6 caracteres');

  const itens = pedido.itens || [];
  if (!itens.length) erros.push('pedido sem itens');
  itens.forEach((it, i) => erros.push(...validarItem(it, i)));

  return erros;
}

// Já existe alguma linha deste pedido na staging? (idempotência — nunca gravar 2x)
async function jaEnviado(Protheus, orderNumber) {
  const r = await Protheus.connectAndQuery(
    `SELECT COUNT(*) n, MAX(RTRIM(ISNULL(Z6_NUM,''))) pedido
       FROM ${TABELA} WHERE Z6_IDPORTAL = @id`, { id: num(orderNumber) });
  return { linhas: Number(r[0]?.n || 0), pedidoErp: trim(r[0]?.pedido) };
}

// Grava as linhas do pedido. Uma por item, como o portal faz.
async function enviar(Protheus, pedido) {
  const erros = validar(pedido);
  if (erros.length) throw new Error(`pedido ${pedido.orderNumber} inválido: ${erros.join('; ')}`);

  const existente = await jaEnviado(Protheus, pedido.orderNumber);
  if (existente.linhas > 0) {
    return { jaExistia: true, linhas: existente.linhas, pedidoErp: existente.pedidoErp };
  }

  const cnpj = soDig(pedido.cnpj);
  let gravadas = 0;
  for (const it of pedido.itens) {
    await Protheus.connectAndQuery(
      `INSERT INTO ${TABELA}
         (Z6_PRODUTO, Z6_QTDVEN, Z6_PRCVEN, Z6_VALOR, Z6_NUM, Z6_CNPJ, Z6_IDPORTAL,
          Z6_ESTATUS, Z6_COND, Z6_FORMAPG, Z6_TABELA, Z6_TRANSP, Z6_CLICOD, Z6_FRETE)
       VALUES
         (@produto, @qtd, @preco, 0, '', @cnpj, @id,
          '', @cond, @forma, @tabela, @transp, @clicod, @frete)`,
      {
        produto: trim(it.produto),
        qtd: num(it.quantidade),
        preco: num(it.preco),
        cnpj,
        id: num(pedido.orderNumber),
        cond: trim(pedido.condPag),
        forma: trim(pedido.formaPag),
        tabela: trim(pedido.tabelaPreco),
        transp: trim(pedido.transportadora),
        clicod: trim(pedido.clienteErp),
        // O portal manda o frete em TODAS as linhas do pedido (não rateado).
        frete: num(pedido.frete)
      });
    gravadas++;
  }
  return { jaExistia: false, linhas: gravadas };
}

// Lê o número que a rotina do Protheus devolveu. Vazio = ainda não processou.
async function lerRetorno(Protheus, orderNumber) {
  const r = await Protheus.connectAndQuery(
    `SELECT COUNT(*) linhas,
            SUM(CASE WHEN RTRIM(ISNULL(Z6_NUM,'')) <> '' THEN 1 ELSE 0 END) com_numero,
            MAX(RTRIM(ISNULL(Z6_NUM,''))) pedido
       FROM ${TABELA} WHERE Z6_IDPORTAL = @id`, { id: num(orderNumber) });
  const linhas = Number(r[0]?.linhas || 0);
  const comNumero = Number(r[0]?.com_numero || 0);
  return {
    linhas,
    comNumero,
    completo: linhas > 0 && comNumero === linhas,
    parcial: comNumero > 0 && comNumero < linhas,
    pedidoErp: trim(r[0]?.pedido)
  };
}

// O cliente existe na SA1? O ERP resolve pelo CNPJ, então conferimos antes de gravar
// — erro aqui vira pedido travado em silêncio, que é o pior modo de falha.
async function resolverCliente(Protheus, cnpj) {
  const d = soDig(cnpj);
  if (!d) return { achou: false, motivo: 'CNPJ vazio' };
  if (!digitosValidos(d)) return { achou: false, motivo: `documento ${d} inválido — não resolvo cliente com ele` };
  const r = await Protheus.connectAndQuery(
    `SELECT TOP 5 RTRIM(A1_COD) cod, RTRIM(A1_LOJA) loja, RTRIM(A1_NOME) nome,
            RTRIM(ISNULL(A1_MSBLQL,'')) bloqueado, RTRIM(ISNULL(A1_EST,'')) uf
       FROM SA1010 WITH (NOLOCK)
      WHERE D_E_L_E_T_ <> '*' AND REPLACE(REPLACE(REPLACE(RTRIM(A1_CGC),'.',''),'/',''),'-','') = @cnpj
      ORDER BY A1_LOJA`, { cnpj: d });
  if (!r.length) return { achou: false, motivo: `nenhum cliente na SA1 com o CNPJ ${d}` };
  const c = r[0];
  return {
    achou: true,
    codigo: trim(c.cod),
    loja: trim(c.loja),
    nome: trim(c.nome),
    uf: trim(c.uf),
    bloqueado: trim(c.bloqueado) === '1',
    lojas: r.length
  };
}

module.exports = { enviar, lerRetorno, jaEnviado, resolverCliente, validar, digitosValidos, TABELA };

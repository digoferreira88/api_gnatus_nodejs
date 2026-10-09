// services/ciospDocs.js — regras compartilhadas do orçamento e do pedido do CIOSP.
//
// Orçamento e pedido são o mesmo documento em estágios diferentes, então tudo que
// vale para os dois (totais, numeração, itens, trilha) mora aqui — e a conversão
// orçamento→pedido não precisa repetir conta nenhuma.
//
// As regras de valor saem do contrato impresso no verso do talão de pedido:
//   - frete grátis, EXCETO região amazônica, onde a venda é acrescida de 3%;
//   - prazo de expedição em branco vale 30 dias.

const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const n2 = (v) => Math.round(N(v) * 100) / 100;

// Cláusula 5 do contrato: frete grátis menos nos estados da região amazônica, onde
// o valor da venda é acrescido de 3%.
const UF_AMAZONIA = new Set(['AC', 'AM', 'RO', 'RR', 'PA', 'AP']);
const PRAZO_EXPEDICAO_PADRAO = 30;   // cláusula 3: prazo em branco = 30 dias

const ehAmazonia = (uf) => UF_AMAZONIA.has(trim(uf).toUpperCase());
const acrescimoAmazonia = (uf, total) => (ehAmazonia(uf) ? n2(N(total) * 0.03) : 0);

// Documento só vale se for CPF ou CNPJ no tamanho certo. A validação de dígito fica
// para a tela; aqui a regra é só "tem documento utilizável".
const documentoValido = (doc) => [11, 14].includes(soDig(doc).length);

// Um item pode vir sem produto do ERP (o talão tem linhas livres em "Peças de mão" e
// "Demais itens"), mas nunca sem descrição e quantidade.
function normalizarItem(it, i) {
  const quantidade = N(it.quantidade) || 0;
  const precoTabela = n2(it.preco_tabela ?? it.precoTabela ?? it.preco);
  const preco = n2(it.preco ?? precoTabela);
  if (!trim(it.descricao)) return { erro: `Item ${i + 1}: falta a descrição.` };
  if (quantidade <= 0) return { erro: `Item ${i + 1}: quantidade precisa ser maior que zero.` };
  if (preco < 0) return { erro: `Item ${i + 1}: preço negativo.` };

  // O desconto é consequência do preço praticado, não um campo à parte — assim a
  // conta nunca diverge do que o cliente vê.
  const descontoPct = precoTabela > 0 ? n2(((precoTabela - preco) / precoTabela) * 100) : 0;
  return {
    item: {
      seq: i + 1,
      produto: trim(it.produto).slice(0, 15) || null,
      descricao: trim(it.descricao).slice(0, 200),
      modelo: trim(it.modelo).slice(0, 80) || null,
      quantidade,
      preco_tabela: precoTabela,
      preco,
      desconto_pct: descontoPct,
      total: n2(preco * quantidade),
      cor_estofamento: trim(it.cor_estofamento || it.corEstofamento).slice(0, 40) || null,
      voltagem: trim(it.voltagem).slice(0, 20) || null,
      prazo_fabric: it.prazo_fabric != null ? Math.round(N(it.prazo_fabric)) : null,
      familia: trim(it.familia).slice(0, 40) || null
    }
  };
}

// Devolve { erro } ou { itens, totais }.
function montarItens(lista) {
  const entrada = Array.isArray(lista) ? lista : [];
  if (!entrada.length) return { erro: 'Inclua pelo menos um item.' };
  const itens = [];
  for (let i = 0; i < entrada.length; i++) {
    const r = normalizarItem(entrada[i], i);
    if (r.erro) return { erro: r.erro };
    itens.push(r.item);
  }
  const totais = itens.reduce((a, it) => ({
    total_bruto: n2(a.total_bruto + it.preco_tabela * it.quantidade),
    total: n2(a.total + it.total)
  }), { total_bruto: 0, total: 0 });
  totais.total_desconto = n2(totais.total_bruto - totais.total);
  return { itens, totais };
}

// Número sequencial por edição, atribuído pelo SERVIDOR (o dispositivo só tem o uuid).
async function proximoNumero(Pg, tabela, edicao) {
  const r = await Pg.connectAndQuery(
    `SELECT COALESCE(MAX(numero), 0) + 1 AS proximo FROM ${tabela} WHERE edicao = @edicao`,
    { edicao });
  return Number(r[0]?.proximo || 1);
}

async function gravarItens(Pg, tabela, campoFk, id, itens) {
  await Pg.connectAndQuery(`DELETE FROM ${tabela} WHERE ${campoFk} = @id`, { id });
  for (const it of itens) {
    await Pg.connectAndQuery(
      `INSERT INTO ${tabela}
        (${campoFk}, seq, produto, descricao, modelo, quantidade, preco_tabela, preco,
         desconto_pct, total, cor_estofamento, voltagem, prazo_fabric, familia)
       VALUES (@id, @seq, @produto, @descricao, @modelo, @quantidade, @preco_tabela, @preco,
               @desconto_pct, @total, @cor_estofamento, @voltagem, @prazo_fabric, @familia)`,
      { id, ...it });
  }
}

async function lerItens(Pg, tabela, campoFk, id) {
  return Pg.connectAndQuery(
    `SELECT seq, produto, descricao, modelo, quantidade, preco_tabela, preco,
            desconto_pct, total, cor_estofamento, voltagem, prazo_fabric, familia
       FROM ${tabela} WHERE ${campoFk} = @id ORDER BY seq`, { id });
}

async function registrar(Pg, documento, documentoId, acao, { de, para, usuarioId } = {}) {
  try {
    await Pg.connectAndQuery(
      `INSERT INTO tab_ciosp_doc_log (documento, documento_id, acao, de, para, usuario_id)
       VALUES (@documento, @documentoId, @acao, @de, @para, @usuarioId)`,
      { documento, documentoId, acao, de: de || null, para: para || null, usuarioId: usuarioId || null });
  } catch (e) {
    // A trilha nunca pode derrubar a operação do vendedor no meio do evento.
    console.warn('ciospDocs/registrar:', e.message);
  }
}

module.exports = {
  trim, soDig, N, n2,
  UF_AMAZONIA, PRAZO_EXPEDICAO_PADRAO, ehAmazonia, acrescimoAmazonia,
  documentoValido, montarItens, proximoNumero, gravarItens, lerItens, registrar
};

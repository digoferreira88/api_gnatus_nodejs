// services/ciospOrcamento.js — o orçamento do estande com o preço do SERVIDOR
// (spec 2026-11-11, seção 5). O app calcula para mostrar offline; quem decide é aqui.
//
//   - recalcularItens: refaz o preço base de cada item pela Tabela Comercial da edição
//     (tabela 13/11 × forma de pagamento) e diz se algum item precisa do gerente;
//   - estadoDesconto: a aprovação do gerente vale para os preços EXATOS (hash): mudou,
//     volta a pendente e precisa ser pedida de novo;
//   - alemDoLivre: quanto o preço praticado passou do mínimo, para o gerente decidir.

const P = require('./ciospPreco');

const reais = (c) => c / 100;

// Item vindo do aparelho → item com o preço da tabela atual. `linhas` são as linhas
// ATIVAS da edição, por id. Item sem linha (livre, ou de outra edição) fica como veio
// e exige o gerente: nenhum preço "de cabeça" passa sem alguém ver.
function recalcularItens(itens, { linhas, tabela, forma, config }) {
  const diferencas = [];
  let exige = false;

  const saida = (itens || []).map((it, i) => {
    const seq = it.seq || i + 1;
    const linha = it.preco_id != null ? linhas.get(Number(it.preco_id)) : null;
    if (!linha) {
      exige = true;
      return { ...it, seq, preco_id: null };
    }

    const base = P.paraCentavos(P.precoBase(linha, tabela, forma));
    const enviado = P.paraCentavos(it.preco_tabela);
    const praticado = P.paraCentavos(it.preco);
    const mudou = !Number.isNaN(enviado) && enviado !== base;
    if (mudou) diferencas.push({ seq, descricao: it.descricao, de: reais(enviado), para: reais(base) });

    // Sem preço, ou o vendedor estava cobrando o base antigo (sem desconto): segue o
    // base novo. Com desconto combinado, o preço fica — e a diferença vai para revisão.
    const precoFinal = Number.isNaN(praticado) || (mudou && praticado === enviado) ? base : praticado;
    if (precoFinal < P.paraCentavos(P.precoMinimo(linha, tabela, forma, config))) exige = true;

    return {
      ...it,
      seq,
      preco_id: Number(linha.id),
      preco_tabela: reais(base),
      preco: reais(precoFinal),
      promocao_pct: linha.promocao_pct == null ? null : Number(linha.promocao_pct),
      promocao_texto: linha.promocao_texto || null,
      promocao_condicional: !!linha.promocao_condicional
    };
  });

  return { itens: saida, diferencas, exige };
}

function estadoDesconto({ exige, hash, atual = {} }) {
  if (!exige) return { desconto_status: 'livre', desconto_hash: null, desconto_solicitado_em: null };
  const mesmaVersao = atual.desconto_hash && atual.desconto_hash === hash;
  if (mesmaVersao && ['aprovado', 'recusado', 'pendente'].includes(atual.desconto_status)) {
    return {
      desconto_status: atual.desconto_status,
      desconto_hash: atual.desconto_hash,
      desconto_solicitado_em: atual.desconto_solicitado_em || null
    };
  }
  return { desconto_status: 'pendente', desconto_hash: null, desconto_solicitado_em: null };
}

function alemDoLivre(item, linha, tabela, forma, config) {
  const minimo = P.paraCentavos(P.precoMinimo(linha, tabela, forma, config));
  const praticado = P.paraCentavos(item.preco);
  if (Number.isNaN(praticado) || praticado >= minimo || minimo <= 0) return 0;
  return Math.round(((minimo - praticado) / minimo) * 10000) / 100;
}

module.exports = { recalcularItens, estadoDesconto, alemDoLivre };

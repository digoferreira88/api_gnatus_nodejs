#!/usr/bin/env node
// Gera a planilha modelo da Tabela Comercial a partir do PDF do CIOSP 2026.
//
//   node scripts/ciosp-tabela-2026-do-pdf.js <TabelaComercial.pdf> <saida.xlsx> [--relatorio]
//
// Uso ÚNICO, para ter a tabela de 2026 no sistema como teste. A partir de 2027 a tabela
// entra pela planilha modelo, preenchida pelo comercial. Precisa do `pdftotext`
// (poppler — vem com o Git for Windows).
//
// Lê o PDF em ordem de leitura (`pdftotext -raw`): cada página = cabeçalho + linhas de
// grupo + itens; cada item termina numa linha com os 4 preços (R$), seguida ou não do
// texto da promoção. Descrições longas (consultórios) ocupam várias linhas antes dos preços.
//
// PROMOÇÕES MESCLADAS: no PDF, uma célula amarela pode valer para várias linhas. Em
// ordem de leitura ela aparece como uma linha solta logo depois do primeiro item do
// bloco. Regra padrão: vale até o próximo item que tenha promoção própria, até o próximo
// grupo ou até o fim da página. As exceções (bloco menor que isso) estão em
// BLOCOS_PROMO, conferidas contra as imagens do PDF.
//
// --relatorio imprime as linhas que não são item nem preço, para conferência.

const { execFileSync } = require('child_process');
const ExcelJS = require('exceljs');
const { COLUNAS } = require('../services/ciospTabela');

// Linhas soltas que são promoção (ou continuação de uma) — o resto é grupo.
const PROMO_RE = new RegExp([
  'DESCONTO ADICIONAL', '^GANHE ', '^UPGRADE PARA', 'VALOR MINIMO', '^VENDA ', '^COMPRE 1',
  '^A SEGUNDA CX$', '^\\+ ?POSICIONADOR$', '^CIONADOR$', '^DOR$', 'KIT MULTIMIDIA',
  '^CAIXA DE FILME AUTO REVELAVEL',
  '^TA NA COMPRA', 'DENTRO DA TABELA', '^TABELA$', '^DA TABELA$', '^COMPRA DO KIT', 'HAND \\+ 50%',
  '^CLEANPACK$', '^COPO$', '^SOM N2 LED', '^JO DE 5 INSERTOS', 'DESCONTO NO DIGITALIZADOR',
  '^JET HAND', 'KIT GARRAFA', 'ESTOJO DE 5', '^\\+ COURO$', 'NA COM-$', 'PRA DO KIT'
].join('|'));

// Exceções à regra padrão: "<página>:<código do 1º item>" → quantas linhas o bloco cobre.
const BLOCOS_PROMO = {
  '5:6188': 3,         // KIT ACADÊMICO: só os 3 kits; adaptador e mochila sem promoção
  // Sensores: a promoção vem na linha do 1º sensor, mas a célula cobre os dois.
  '9:6252': 2, '18:6252': 2, '21:6252': 2, '24:6252': 2
};

const PRECO_RE = /R\$ ?([\d.,]+)/g;
const num = (s) => Number(String(s).replace(/,/g, ''));   // PDF em formato americano: 1,307.49

function lerPaginas(pdf) {
  const txt = execFileSync('pdftotext', ['-raw', '-enc', 'UTF-8', pdf, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return txt.split('\f').map(p => p.split(/\r?\n/).map(l => l.trim()).filter(Boolean)).filter(p => p.length);
}

// "531 + 530 16000002811 + 8272 KIT ..." → { tes, codigo, resto }
function inicioDeItem(linha) {
  let m = linha.match(/^(\d{3}(?: \+ \d{3})?)(?:\s+(.*))?$/);
  let tes = null;
  let resto = linha;
  if (m) { tes = m[1]; resto = m[2] || ''; }
  else if (!/^\d{4,}/.test(linha)) return null;              // nem TES nem código: não é item
  const c = resto.match(/^(CONF COR|\d{4,}(?:\s*\+\s*(?:\d{3,}|CHICOTE))*)(?:\s+(.*))?$/);
  if (c) return { tes, codigo: c[1].replace(/\s+/g, ' '), resto: c[2] || '' };
  return { tes, codigo: '', resto };
}

function juntar(partes) {
  // "INTEGRA-" + "DA" → "INTEGRADA" (hífen de quebra de linha); " - " de verdade fica.
  return partes.join(' ').replace(/[“”"]/g, '').replace(/(\w)- (\w)/g, '$1$2').replace(/\s+/g, ' ').trim();
}

function extrair(paginas, relatorio) {
  const itens = [];
  const soltas = [];
  paginas.forEach((linhas, ip) => {
    const pagina = ip + 1;
    const iPix = linhas.findIndex(l => l.startsWith('PIX chave'));
    const secao = linhas[iPix + 1];
    let i = linhas.lastIndexOf('OU 6% NO PIX') + 1;

    // Página que continua a mesma seção continua também o último grupo da anterior.
    const anteriorItem = itens[itens.length - 1];
    let grupo = anteriorItem && anteriorItem.secao === secao ? anteriorItem.grupo : null;
    let pendente = null;          // item cujos preços ainda não vieram
    let emAspas = false;
    let ultimo = null;            // último item completo
    let bloco = null;             // promoção mesclada { texto, itens[], restam }
    let anterior = null;          // tipo da linha anterior

    for (; i < linhas.length; i++) {
      const l = linhas[i];
      const precos = [...l.matchAll(PRECO_RE)];

      if (precos.length >= 4 && !emAspas) {
        const antes = l.slice(0, precos[0].index).trim();
        const fimP = precos[3].index + precos[3][0].length;
        const promo = l.slice(fimP).trim() || null;
        let item = pendente;
        if (antes) {
          const ini = item ? null : inicioDeItem(antes);
          if (ini) item = { tes: ini.tes, codigo: ini.codigo, desc: [ini.resto] };
          else if (item) item.desc.push(antes);
          else item = { tes: null, codigo: '', desc: [antes] };
        }
        if (!item) throw new Error(`p${pagina}: preços sem item: ${l}`);
        const novo = {
          pagina, secao, grupo, tes: item.tes, codigo: item.codigo, descricao: juntar(item.desc),
          precos: precos.slice(0, 4).map(p => num(p[1])), promocao: promo
        };
        if (promo) {
          const total = BLOCOS_PROMO[`${pagina}:${item.codigo}`];
          bloco = total ? { texto: promo, itens: [novo], restam: total - 1 } : null;
        }
        else if (bloco && bloco.restam !== 0) {
          novo.promocao = bloco.texto; bloco.itens.push(novo);
          if (bloco.restam > 0) bloco.restam -= 1;
        }
        itens.push(novo);
        ultimo = novo;
        pendente = null;
        anterior = promo ? 'preco-com-promo' : 'preco';
        continue;
      }

      if (emAspas || /^[“"]/.test(l)) {
        if (!pendente) pendente = { tes: null, codigo: '', desc: [] };
        pendente.desc.push(l);
        emAspas = !(/[”"]$/.test(l) && !(l.length === 1));
        anterior = 'desc';
        continue;
      }

      const ini = pendente ? null : inicioDeItem(l);
      if (ini) { pendente = { tes: ini.tes, codigo: ini.codigo, desc: ini.resto ? [ini.resto] : [] }; anterior = 'item'; continue; }
      if (pendente) { pendente.desc.push(l); anterior = 'desc'; continue; }

      if (PROMO_RE.test(l) && ultimo && ultimo.pagina === pagina) {
        if (anterior === 'preco-com-promo' || (anterior === 'promo' && !bloco)) {
          ultimo.promocao = juntar([ultimo.promocao, l]);                       // continuação da própria linha
          if (bloco && bloco.itens[0] === ultimo) bloco.texto = ultimo.promocao;
          soltas.push(`p${pagina} [promo+] ${l}`);
        } else if (anterior === 'promo' && bloco) {
          bloco.texto = juntar([bloco.texto, l]);                              // continuação do bloco
          bloco.itens.forEach(it => { it.promocao = bloco.texto; });
          soltas.push(`p${pagina} [bloco+] ${l}`);
        } else {
          const total = BLOCOS_PROMO[`${pagina}:${ultimo.codigo}`];
          bloco = { texto: l, itens: [ultimo], restam: total ? total - 1 : -1 };
          ultimo.promocao = l;
          soltas.push(`p${pagina} [bloco] ${l}  (a partir de ${ultimo.codigo || ultimo.descricao.slice(0, 30)}${total ? ', ' + total + ' linhas' : ''})`);
        }
        anterior = 'promo';
        continue;
      }

      soltas.push(`p${pagina} [grupo] ${l}`);
      grupo = l;
      bloco = null;
      anterior = 'grupo';
    }
    if (pendente) throw new Error(`p${pagina}: item sem preços: ${pendente.desc.join(' ')}`);
  });
  if (relatorio) console.log(soltas.join('\n'));
  return itens;
}

function percentual(texto) {
  const m = String(texto || '').match(/(\d+)% DE DESCONTO ADICIONAL/);
  return m ? Number(m[1]) : null;
}

async function main() {
  const [pdf, saida] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const relatorio = process.argv.includes('--relatorio');
  if (!pdf || !saida) {
    console.error('uso: node scripts/ciosp-tabela-2026-do-pdf.js <pdf> <saida.xlsx> [--relatorio]');
    process.exit(2);
  }
  const itens = extrair(lerPaginas(pdf), relatorio);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tabela');
  ws.addRow(COLUNAS);
  ws.getRow(1).font = { bold: true };
  for (const it of itens) {
    const pct = percentual(it.promocao);
    const condicional = pct != null && it.promocao.replace(/\d+% DE DESCONTO ADICIONAL/, '').trim() !== '';
    ws.addRow([it.secao, it.grupo, it.tes, it.codigo, it.descricao, ...it.precos,
      it.promocao, pct, condicional ? 'S' : 'N', null]);
  }
  await wb.xlsx.writeFile(saida);

  const porSecao = {};
  for (const it of itens) porSecao[it.secao] = (porSecao[it.secao] || 0) + 1;
  console.log(`${itens.length} linhas →`, saida);
  console.log(Object.entries(porSecao).map(([s, n]) => `  ${s}: ${n}`).join('\n'));
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });

// Teste do parser Santander (033) com titulos ALFANUMERICOS.
// Uso: node scripts/test-cnab-santander-alfanumerico.js
//
// Caso real: borderô 418812 (retorno COBST_DJ68_02_011026P_MOV.TXT, 01/10/2026)
// trouxe o titulo FT/OMN167488/06 tipo BOL. O seu numero da remessa saiu
// truncado ("OMN16706") e a regex antiga (numero de 6 digitos, especie DP|NF)
// nao enxergava a linha. As linhas abaixo reproduzem os campos do arquivo real.

const assert = require('assert');
const Cnab = require('../services/cnabRetornoFiltro');

// Monta uma linha-detalhe de 400 posicoes com os campos nas posicoes do layout.
function detalhe({ uso, nn, ocor, data = '300926', seu, venc = '300926', valor, conta = '13000208', seq }) {
  const l = Array(400).fill(' ');
  const put = (pos, s) => { for (let i = 0; i < s.length; i++) l[pos + i] = s[i]; };
  put(0, '102096093560001000820' + '13000208' + conta);
  put(37, uso.padEnd(25));
  put(62, nn);
  put(107, '2' + ocor + data);
  put(116, seu.padEnd(10));
  put(146, venc);
  put(152, String(Math.round(valor * 100)).padStart(13, '0'));
  put(394, String(seq).padStart(6, '0'));
  return l.join('');
}
const header = '02RETORNO01COBRANCA'.padEnd(94) + '300926' + ''.padEnd(294) + '000001';
const trailer = (seq) => '9201033'.padEnd(394) + String(seq).padStart(6, '0');

const L_NUM = detalhe({ uso: 'PED094610   04DP', nn: '00202541', ocor: '06', seu: '09461004', valor: 3333.33, seq: 2 });
const L_NF = detalhe({ uso: '1  089056   03NF', nn: '00197831', ocor: '06', seu: '08905603', valor: 3130.53, seq: 3 });
const L_ALFA = detalhe({ uso: 'FT OMN16748806BOL', nn: '00207187', ocor: '02', seu: 'OMN16706', venc: '051026', valor: 1335.71, seq: 4 });
const arquivo = [header, L_NUM, L_NF, L_ALFA, trailer(5)].join('\r\n') + '\r\n';

// 1) Chave sai inteira do uso da empresa, inclusive alfanumerica e tipo de 3
assert.deepStrictEqual(Cnab.chaveLinha(L_NUM), { prefixo: 'PED', numero: '094610', parcela: '04' });
assert.deepStrictEqual(Cnab.chaveLinha(L_NF), { prefixo: '1', numero: '089056', parcela: '03' });
assert.deepStrictEqual(Cnab.chaveLinha(L_ALFA), { prefixo: 'FT', numero: 'OMN167488', parcela: '06' });
assert.strictEqual(Cnab.chaveLinha(header), null);
assert.strictEqual(Cnab.chaveLinha(trailer(5)), null);

// 2) parseDetalhes devolve as tres linhas (antes: so as duas numericas)
const det = Cnab.parseDetalhes(arquivo);
assert.strictEqual(det.length, 3);
const alfa = det.find(d => d.numero === 'OMN167488');
assert.ok(alfa, 'linha alfanumerica precisa aparecer no parse');
assert.strictEqual(alfa.especie, 'BOL');
assert.strictEqual(alfa.nossoNumero, '00207187');
assert.strictEqual(alfa.ocorrencia, '02');
assert.strictEqual(alfa.seuNumero, 'OMN16706');
assert.strictEqual(alfa.valor, 1335.71);
assert.strictEqual(det.find(d => d.numero === '094610').ocorrencia, '06');
assert.strictEqual(det.find(d => d.numero === '094610').especie, 'DP');

// 3) Chaves para o filtro de ja-baixados incluem o alfanumerico
assert.strictEqual(Cnab.extrairChaves(arquivo).length, 3);

// 4) Cota unica (parcela vazia)
const L_COTA = detalhe({ uso: 'PED095136     DP', nn: '00204811', ocor: '02', seu: '095136', valor: 10, seq: 2 });
assert.deepStrictEqual(Cnab.chaveLinha(L_COTA), { prefixo: 'PED', numero: '095136', parcela: '' });

// 5) Filtro de ja-baixados (refatorado) casa o alfanumerico, renumera e
//    devolve o arquivo byte a byte igual quando nao remove nada
const fb = Cnab.filtrarBaixados(arquivo, new Set(['FT|OMN167488|06']));
assert.strictEqual(fb.removidos.length, 1);
assert.strictEqual(fb.mantidos, 2);
assert.strictEqual(fb.total, 3);
assert.ok(!fb.conteudo.includes('OMN167488'));
const linhas = fb.conteudo.split('\r\n').filter(Boolean);
assert.deepStrictEqual(linhas.map(l => l.slice(-6)), ['000001', '000002', '000003', '000004']);
assert.ok(linhas.every(l => l.length === 400));
assert.strictEqual(Cnab.filtrarBaixados(arquivo, new Set()).conteudo, arquivo);

// 8) Divisao por conta continua funcionando com a linha alfanumerica
const L_OUTRA = detalhe({ uso: 'PED072224   27DP', nn: '00198510', ocor: '06', seu: '07222427', valor: 4531.33, conta: '29000258', seq: 5 });
const multi = [header, L_NUM, L_ALFA, L_OUTRA, trailer(5)].join('\r\n') + '\r\n';
const partes = Cnab.dividirPorConta(multi, '033');
assert.deepStrictEqual(partes.map(p => [p.conta, p.linhas]), [['13000208', 2], ['29000258', 1]]);

// 9) Bradesco: tipo de 3 letras nao e' mais cortado
const br = Array(400).fill(' ');
const putB = (pos, s) => { for (let i = 0; i < s.length; i++) br[pos + i] = s[i]; };
putB(0, '1'); putB(37, 'FT OMN16748806BOL'); putB(70, '00000015761'); putB(81, '1'); putB(108, '02300926');
putB(152, '0000000133571');
const pb = Cnab.parseDetalhesBradesco(br.join(''));
assert.strictEqual(pb.length, 1);
assert.strictEqual(pb[0].numero, 'OMN167488');
assert.strictEqual(pb[0].especie, 'BOL');

console.log('OK — parser Santander alfanumerico: todas as verificacoes passaram');

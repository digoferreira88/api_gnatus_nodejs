// Adoção de títulos da SE1 (borderô feito fora da intranet).
// Caso real: borderô 001522 (Itaú, 25/11/2026). Os lotes #63/#64 da intranet
// falharam (HTTP 504, ERRO_PROTHEUS), o financeiro fez o borderô no Protheus e
// importou o retorno — e os 52 títulos registrados nunca chegaram ao disparo.
const test = require('node:test');
const assert = require('node:assert');
const BoletoAdotar = require('../services/boletoAdotar');

// SE1 falsa que respeita a cláusula de ocorrência da consulta, nas duas formas
// (= '02' ou IN ('02','21') / IN (@oc0, @oc1)).
function protheusFalso(titulos) {
  return {
    connectAndQuery: async (sql, params = {}) => {
      const m = sql.match(/E1_OCORREN\)\s*(?:=\s*'(\d+)'|IN\s*\(([^)]*)\))/i);
      assert.ok(m, 'a consulta da SE1 tem que filtrar E1_OCORREN');
      const aceitas = m[1] ? [m[1]] : m[2].split(',').map(s => s.trim())
        .map(s => (s.startsWith('@') ? params[s.slice(1)] : s.replace(/'/g, '')));
      return titulos.filter(t => aceitas.includes(t.ocorren));
    }
  };
}

// Linhas de lote_titulo × lote × retorno (o Pg falso devolve sempre as mesmas).
const pgFalso = (linhas) => ({ connectAndQuery: async () => linhas });

const tit = (numero, ocorren) => ({
  prefixo: 'PED', numero, parcela: '02', tipo: 'DP', cliente_cod: '171473', cliente_loja: '01',
  numbco: `${numero}02`, portador: '341', agencia: '0298', conta: '25776', bordero: '001522',
  valor: 100, vencimento: '20261225', ocorren
});
const emLote = (numero, id, lote_status, status_banco = null) => ({
  prefixo: 'PED', numero, parcela: '02', cliente_cod: '171473', cliente_loja: '01',
  id_lote: id, lote_status, status_banco
});

test('título só em lote que falhou no Protheus (ERRO_PROTHEUS) é adotado', async () => {
  const { novos } = await BoletoAdotar.elegiveisParaAdotar({
    Protheus: protheusFalso([tit('098669', '02')]),
    Pg: pgFalso([emLote('098669', 63, 'ERRO_PROTHEUS'), emLote('098669', 64, 'ERRO_PROTHEUS')])
  });
  assert.deepStrictEqual(novos.map(n => n.numero), ['098669']);
});

test('título que saiu do lote de outro banco (TRANSFERIDO) é adotado', async () => {
  const { novos } = await BoletoAdotar.elegiveisParaAdotar({
    Protheus: protheusFalso([tit('093809', '02')]),
    Pg: pgFalso([emLote('093809', 54, 'RETORNADO', 'TRANSFERIDO'), emLote('093809', 63, 'ERRO_PROTHEUS')])
  });
  assert.deepStrictEqual(novos.map(n => n.numero), ['093809']);
});

test('Itaú: ocorrência 21 (entrada confirmada) conta como registrado', async () => {
  const { novos } = await BoletoAdotar.elegiveisParaAdotar({
    Protheus: protheusFalso([tit('089284', '21'), tit('090231', '01')]),
    Pg: pgFalso([])
  });
  assert.deepStrictEqual(novos.map(n => n.numero), ['089284']);
});

test('título em lote vivo da intranet NÃO é adotado de novo', async () => {
  const { novos } = await BoletoAdotar.elegiveisParaAdotar({
    Protheus: protheusFalso([tit('1', '21'), tit('2', '21'), tit('3', '02'), tit('4', '02'), tit('5', '02')]),
    Pg: pgFalso([
      emLote('1', 69, 'ENVIADO_PROTHEUS'),            // ainda sem sincronizar
      emLote('2', 70, 'RETORNADO', 'REGISTRADO'),
      emLote('3', 71, 'CRIADO'),                      // pode ser enviado ainda
      emLote('4', 72, 'DISPARADO', 'LIQUIDADO'),
      emLote('5', 73, 'ERRO_PROTHEUS'), emLote('5', 74, 'RETORNADO', 'REGISTRADO')
    ])
  });
  assert.deepStrictEqual(novos, []);
});

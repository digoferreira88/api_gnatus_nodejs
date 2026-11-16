// A migration 153 roda como postgres em produção: a tabela nova precisa de GRANT para o
// role da API (intranet), senão o painel do Protheus dá "permission denied".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(path.join(__dirname, '../database/postgres/153-ciosp-protheus-envio.sql'), 'utf8');

test('migration 153 dá acesso à tabela de tentativas e à sequence para o role intranet', () => {
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON tab_ciosp_protheus_envio TO intranet;/);
  assert.match(sql, /GRANT USAGE, SELECT ON SEQUENCE tab_ciosp_protheus_envio_id_seq TO intranet;/);
});

// Testes das fotos e catálogos do CIOSP (services/ciospMidia.js).
// Rodar:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dirTeste = fs.mkdtempSync(path.join(os.tmpdir(), 'ciosp-midia-'));
process.env.CIOSP_MIDIA_DIR = dirTeste;
const M = require('../services/ciospMidia');

test('dirMidia respeita CIOSP_MIDIA_DIR', () => {
  assert.equal(M.dirMidia(), dirTeste);
});

test('nomeArquivo é o sha256 do conteúdo com a extensão do tipo', () => {
  const buf = Buffer.from('foto de teste');
  const a = M.nomeArquivo(buf, 'image/webp');
  assert.match(a, /^[a-f0-9]{64}\.webp$/);
  assert.equal(M.nomeArquivo(buf, 'image/webp'), a);
  assert.match(M.nomeArquivo(buf, 'image/jpeg'), /\.jpg$/);
  assert.match(M.nomeArquivo(buf, 'image/png'), /\.png$/);
  assert.match(M.nomeArquivo(buf, 'application/pdf'), /\.pdf$/);
  assert.notEqual(M.nomeArquivo(Buffer.from('outra'), 'image/webp'), a);
});

test('nomeArquivo recusa tipo fora da lista', () => {
  assert.throws(() => M.nomeArquivo(Buffer.from('x'), 'text/plain'), /tipo de arquivo não aceito/);
});

test('gravar não regrava o mesmo conteúdo', async () => {
  const buf = Buffer.from('mesma foto');
  const r1 = await M.gravar(buf, 'image/webp');
  const r2 = await M.gravar(buf, 'image/webp');
  assert.equal(r1.novo, true);
  assert.equal(r2.novo, false);
  assert.equal(r1.arquivo, r2.arquivo);
  assert.equal(r1.bytes, buf.length);
  assert.ok(fs.existsSync(path.join(dirTeste, r1.arquivo)));
});

test('nomeValido só aceita o padrão gerado', () => {
  assert.equal(M.nomeValido('a'.repeat(64) + '.webp'), true);
  assert.equal(M.nomeValido('a'.repeat(64) + '.pdf'), true);
  assert.equal(M.nomeValido('../../.env'), false);
  assert.equal(M.nomeValido('a'.repeat(63) + '.webp'), false);
  assert.equal(M.nomeValido('a'.repeat(64) + '.exe'), false);
});

test('fotoDaLinha: foto da linha, senão a do código, senão nenhuma', () => {
  const fotos = [{ id: 7, codigo: '1116' }, { id: 8, codigo: 'CONF COR' }];
  assert.equal(M.fotoDaLinha({ foto_id: 3, codigo: '1116' }, fotos), 3);
  assert.equal(M.fotoDaLinha({ foto_id: null, codigo: '1116' }, fotos), 7);
  assert.equal(M.fotoDaLinha({ foto_id: null, codigo: 'CONF COR' }, fotos), 8);
  assert.equal(M.fotoDaLinha({ foto_id: null, codigo: '9999' }, fotos), null);
  assert.equal(M.fotoDaLinha({ foto_id: null, codigo: null }, fotos), null);
});

// Limitador do POST /users/login: barra força bruta (tentativas ERRADAS) sem travar uma
// sala de treinamento ou o estande do CIOSP atrás de um mesmo IP (logins CERTOS).
// Rodar:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

async function subir(statusDoHandler) {
  delete require.cache[require.resolve('../resources/users/users.login.js')];
  delete require.cache[require.resolve('../middlewares/rateLimit.js')];
  const rota = require('../resources/users/users.login.js')({ services: {} });
  const app = express();
  app.post('/login', ...rota.middlewares, (req, res) => res.status(statusDoHandler).json({ ok: true }));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const post = () => new Promise((ok, falha) => {
    const req = http.request({ port: server.address().port, path: '/login', method: 'POST' }, res => { res.resume(); res.on('end', () => ok(res.statusCode)); });
    req.on('error', falha); req.end();
  });
  return { server, post };
}

test('login: 25 logins CERTOS seguidos do mesmo IP não são bloqueados', async () => {
  const { server, post } = await subir(200);
  try {
    const status = [];
    for (let i = 0; i < 25; i++) status.push(await post());
    assert.deepEqual([...new Set(status)], [200]);
  } finally { server.close(); }
});

test('login: tentativas ERRADAS continuam limitadas', async () => {
  const { server, post } = await subir(401);
  try {
    const status = [];
    for (let i = 0; i < 25; i++) status.push(await post());
    assert.ok(status.includes(429), `esperava 429 depois de várias falhas: ${status.join(',')}`);
  } finally { server.close(); }
});

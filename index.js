// index.js

// PASSO 1: Carrega as variáveis de ambiente. DEVE SER A PRIMEIRA COISA NO ARQUIVO.
require('dotenv').config();


const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const server = http.createServer(app);

// Em producao a app fica atras do Nginx (proxy reverso). Sem 'trust proxy', o
// req.ip vira sempre 127.0.0.1 e o express-rate-limit cospe ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
// Confiamos so no PRIMEIRO proxy (Nginx local) — nao no header em si vindo de fora.
app.set('trust proxy', 1);

// Helmet — adiciona headers de seguranca (HSTS, X-Frame-Options, nosniff,
// X-DNS-Prefetch-Control, Referrer-Policy etc). CSP fica DESLIGADA aqui
// porque a API so retorna JSON/arquivos; o front (React/Vite) gerencia seu
// proprio CSP via nginx. crossOriginResourcePolicy desligado tambem porque
// servimos PDFs/imagens que o front abre em outras abas.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false
}));

// CORS — whitelist por env (CSV). Em dev libera localhost:5173 por padrao.
// IMPORTANTE: browsers NAO enviam header Origin em requests SAME-ORIGIN
// (so cross-origin). Entao `!origin` = same-origin do nginx OU server-to-server.
// Em qualquer caso eh seguro liberar — a auth do JWT cobre.
const CORS_ORIGINS = (process.env.CORS_ORIGINS ||
  'http://localhost:5173,http://localhost:3000,https://intranew.gnatus.com.br'
).split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                   // same-origin ou server-to-server
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: origem nao permitida (${origin})`));
  },
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept']
}));

// Body limits reduzidos. JSON 50mb era trivialmente DoS-avel.
// 16mb cobre compras/sc-criar com ate ~10MB de anexos base64 (limitado no
// proprio endpoint). Multer (uploads file) tem limit proprio (4MB) e
// nao passa por aqui.
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: false, limit: '16mb' }));

const loader = require('./config/loader');

// PASSO 2: Agora que as variáveis existem, carregamos os serviços
app.services = loader(path.join(__dirname, 'services'), app);
app.io = require('socket.io')(server);

// PASSO 3: Carregamos as rotas da API
require('./config/resources')(app, {
  directory: path.join(__dirname, 'resources'),
  log: 'errors',
  authentication: require('./middlewares/authentication')(app),
  environment: process.env.NODE_ENV || 'development'
});

// PASSO 4: Inicia jobs cron (cobranca-whatsapp + futuros)
app.services.Scheduler.start(app);

const Jwt = require('./services/jwt')();

app.io.on('connection', socket => {
  const token = socket.handshake.query.token;
  if (!token) socket.disconnect();

  const tokenData = Jwt.verify(token.split(' ')[1]);
  if (!tokenData) socket.disconnect();

  socket.userId = tokenData.id;
  socket.join(`user_${tokenData.id}`);

  socket.on('join', room => {
    socket.join(room);
  });
  socket.on('leave', room => {
    socket.leave(room);
  });
});

const port = process.env.PORT || 3000

server.listen(port, () => {
  console.log(`API running on port: ${port}`);
})


// index.js

// PASSO 1: Carrega as variáveis de ambiente. DEVE SER A PRIMEIRA COISA NO ARQUIVO.
require('dotenv').config();


const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS — whitelist por env (CSV). Em dev libera localhost:5173 por padrao.
const CORS_ORIGINS = (process.env.CORS_ORIGINS ||
  'http://localhost:5173,http://localhost:3000,https://intranew.gnatus.com.br'
).split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Sem origin (curl, server-to-server) liberamos. Browser sempre manda Origin.
    if (!origin) return cb(null, true);
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: origem nao permitida (${origin})`));
  },
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

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


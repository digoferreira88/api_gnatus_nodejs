// services/bbPix.js — conversa com a API Pix do Banco do Brasil.
//
// O BB implementa a API Pix do Bacen (openapi 2.11): os caminhos e os campos
// vêm de lá, e é essa a referência que vale quando a documentação do BB e a
// realidade discordarem.
//
//   PUT  /cobv/{txid}   cria a cobrança COM VENCIMENTO (o banco calcula multa e
//                       juros no ato do pagamento — decisão do usuário, 30/10)
//   GET  /cobv/{txid}   consulta a cobrança
//   PATCH /cobv/{txid}  revisa ou cancela (status REMOVIDA_PELO_USUARIO_RECEBEDOR)
//   GET  /pix           lista os Pix RECEBIDOS num período, filtrável por txid
//
// Autenticação em três camadas, conforme docs/financeiro/OpenAPI_BB_Pix_v2.json
// (API Pix do BB, v2.10.6):
//   1. OAuth2 client_credentials (Basic client_id:client_secret) -> access_token
//   2. mTLS — exigência do Bacen
//   3. `gw-dev-app-key` na QUERY STRING (a developer_application_key do portal)
//
// Ambientes, da própria especificação:
//   homologação  https://api-pix.hm.bb.com.br/pix/v2  ·  https://oauth.hm.bb.com.br/oauth/token
//   produção     https://api-pix.bb.com.br/pix/v2     ·  https://oauth.bb.com.br/oauth/token
//
// BB_PIX_SIMULAR=1 responde sem tocar no banco, para o fluxo inteiro poder ser
// testado antes de existir credencial. Mesmo padrão do Datafrete.

const https = require('https');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Produção só entra quando BB_PIX_AMBIENTE=producao: o default é homologação,
// para um .env incompleto nunca cobrar ninguém de verdade.
const PRODUCAO = () => trim(process.env.BB_PIX_AMBIENTE).toLowerCase() === 'producao';
const PADRAO = {
  homologacao: { api: 'https://api-pix.hm.bb.com.br/pix/v2', token: 'https://oauth.hm.bb.com.br/oauth/token' },
  producao: { api: 'https://api-pix.bb.com.br/pix/v2', token: 'https://oauth.bb.com.br/oauth/token' }
};

const CFG = () => ({
  tokenUrl: trim(process.env.BB_PIX_TOKEN_URL) || PADRAO[PRODUCAO() ? 'producao' : 'homologacao'].token,
  apiUrl: (trim(process.env.BB_PIX_API_URL) || PADRAO[PRODUCAO() ? 'producao' : 'homologacao'].api).replace(/\/+$/, ''),
  clientId: trim(process.env.BB_PIX_CLIENT_ID),
  clientSecret: trim(process.env.BB_PIX_CLIENT_SECRET),
  appKey: trim(process.env.BB_PIX_APP_KEY),
  chave: trim(process.env.BB_PIX_CHAVE),              // chave Pix do recebedor
  // Só os escopos que usamos: criar/consultar cobv e ler os Pix recebidos.
  scope: trim(process.env.BB_PIX_SCOPE) || 'cobv.read cobv.write pix.read',
  certPem: trim(process.env.BB_PIX_CERT_PEM),
  keyPem: trim(process.env.BB_PIX_KEY_PEM),
  pfx: trim(process.env.BB_PIX_CERT_PFX),
  pfxSenha: trim(process.env.BB_PIX_CERT_SENHA),
  simular: trim(process.env.BB_PIX_SIMULAR) === '1'
});

const configurado = () => {
  const c = CFG();
  return c.simular || !!(c.tokenUrl && c.apiUrl && c.clientId && c.clientSecret && c.chave);
};

// ------------------------------------------------------------------ mTLS
let agente = null;
function agenteHttps() {
  if (agente) return agente;
  const c = CFG();
  const opts = { keepAlive: true };
  try {
    if (c.pfx) {
      opts.pfx = fs.readFileSync(c.pfx);
      if (c.pfxSenha) opts.passphrase = c.pfxSenha;
    } else if (c.certPem && c.keyPem) {
      opts.cert = fs.readFileSync(c.certPem);
      opts.key = fs.readFileSync(c.keyPem);
    }
  } catch (e) {
    // Sem certificado legível não adianta seguir em produção, mas em
    // homologação o BB aceita só o token — então avisa e continua.
    console.warn('[bbPix] certificado não carregado:', e.message);
  }
  agente = new https.Agent(opts);
  return agente;
}

// ------------------------------------------------------------------ token
let token = { valor: null, expira: 0 };
async function acessar() {
  const c = CFG();
  if (token.valor && Date.now() < token.expira) return token.valor;

  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
  const { data } = await axios.post(
    c.tokenUrl,
    new URLSearchParams({ grant_type: 'client_credentials', scope: c.scope }).toString(),
    {
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      httpsAgent: agenteHttps(),
      timeout: 30000
    });

  if (!data?.access_token) throw new Error('BB não devolveu access_token');
  // Renova um minuto antes de vencer: token expirado no meio de um lote de
  // cobranças falha metade delas sem motivo.
  token = { valor: data.access_token, expira: Date.now() + (N(data.expires_in) - 60) * 1000 };
  return token.valor;
}

async function chamar(metodo, caminho, corpo, params = {}) {
  const c = CFG();
  if (!c.apiUrl) throw new Error('BB_PIX_API_URL não configurada');
  const acesso = await acessar();
  const { data } = await axios({
    method: metodo,
    url: `${c.apiUrl}${caminho}`,
    data: corpo,
    params: c.appKey ? { 'gw-dev-app-key': c.appKey, ...params } : params,
    headers: { Authorization: `Bearer ${acesso}`, 'Content-Type': 'application/json' },
    httpsAgent: agenteHttps(),
    timeout: 45000
  });
  return data;
}

// Erro da API Pix vem no formato RFC 7807 (type/title/detail/violacoes). A
// mensagem crua do axios ("Request failed with status code 400") não ajuda
// ninguém a entender o que o banco recusou.
function explicar(err) {
  const d = err.response?.data;
  if (!d) return err.message;
  const violacoes = Array.isArray(d.violacoes)
    ? ' — ' + d.violacoes.map(v => `${v.propriedade || ''}: ${v.razao || ''}`.trim()).join('; ')
    : '';
  return `${d.title || d.error || err.message}${d.detail ? ': ' + d.detail : ''}${violacoes}`;
}

// --------------------------------------------------------------- simulação
const simulado = {
  cobv(txid, corpo) {
    const chave = CFG().chave || 'simulada@gnatus.com.br';
    // BR Code só para a tela ter o que mostrar — NÃO é pagável.
    const bruto = `00020126580014BR.GOV.BCB.PIX0136${chave}520400005303986540${String(corpo.valor.original).length}${corpo.valor.original}5802BR5913GNATUS6008BARRETOS62${String(txid.length + 4).padStart(2, '0')}05${String(txid.length).padStart(2, '0')}${txid}6304SIMU`;
    return {
      txid,
      status: 'ATIVA',
      calendario: corpo.calendario,
      valor: corpo.valor,
      chave,
      pixCopiaECola: bruto,
      loc: { id: Math.floor(Math.random() * 1e6), location: `simulado.gnatus/pix/${txid}` },
      simulado: true
    };
  }
};

// ------------------------------------------------------------------ API
// Cobrança COM VENCIMENTO. `multaPerc`/`jurosPerc` vão como percentuais e quem
// calcula o valor final é o banco, no momento do pagamento.
//   multa modalidade 2 = percentual
//   juros modalidade 3 = percentual ao mês, dias corridos
async function criarCobv({ txid, valor, vencimento, validadeDias, devedor, descricao, multaPerc, jurosPerc }) {
  const c = CFG();
  const corpo = {
    calendario: {
      dataDeVencimento: vencimento,
      validadeAposVencimento: Number(validadeDias) || 30
    },
    devedor: devedor.cnpj
      ? { cnpj: devedor.cnpj, nome: devedor.nome }
      : { cpf: devedor.cpf, nome: devedor.nome },
    valor: { original: N(valor).toFixed(2) },
    chave: c.chave,
    solicitacaoPagador: trim(descricao).slice(0, 140)
  };
  if (N(multaPerc) > 0) corpo.valor.multa = { modalidade: 2, valorPerc: N(multaPerc).toFixed(2) };
  if (N(jurosPerc) > 0) corpo.valor.juros = { modalidade: 3, valorPerc: N(jurosPerc).toFixed(2) };

  if (c.simular) return simulado.cobv(txid, corpo);
  try {
    return await chamar('put', `/cobv/${txid}`, corpo);
  } catch (err) {
    throw new Error(explicar(err));
  }
}

async function consultarCobv(txid) {
  if (CFG().simular) return { txid, status: 'ATIVA', simulado: true };
  try {
    return await chamar('get', `/cobv/${txid}`);
  } catch (err) {
    throw new Error(explicar(err));
  }
}

async function cancelarCobv(txid) {
  if (CFG().simular) return { txid, status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR', simulado: true };
  try {
    return await chamar('patch', `/cobv/${txid}`, { status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' });
  } catch (err) {
    throw new Error(explicar(err));
  }
}

// Pix recebidos no período. É por aqui que a conciliação acontece: perguntamos
// ao banco em vez de esperar um webhook, e assim nenhuma porta da internet
// precisa chegar na intranet.
async function listarRecebidos({ inicio, fim, txid, pagina = 0 }) {
  if (CFG().simular) {
    // Gancho de teste: BB_PIX_SIMULAR_PAGOS=txid1,txid2 faz a conciliação achar
    // esses pagamentos. É como se vê a fila do financeiro encher sem precisar
    // de credencial nem de dinheiro de verdade.
    const fingir = trim(process.env.BB_PIX_SIMULAR_PAGOS).split(',').map(trim).filter(Boolean);
    const pix = fingir.map(t => ({
      endToEndId: ('E00000000' + t).replace(/[^A-Za-z0-9]/g, '').slice(0, 32).padEnd(32, '0'),
      txid: t,
      valor: trim(process.env.BB_PIX_SIMULAR_VALOR) || '0.01',
      horario: new Date().toISOString(),
      pagador: { cpf: '00000000000', nome: 'PAGADOR SIMULADO' }
    }));
    return { pix, parametros: { paginacao: { quantidadeDePaginas: pix.length ? 1 : 0 } }, simulado: true };
  }
  const params = {
    inicio: new Date(inicio).toISOString(),
    fim: new Date(fim).toISOString(),
    'paginacao.paginaAtual': pagina
  };
  if (txid) params.txid = txid;
  try {
    return await chamar('get', '/pix', undefined, params);
  } catch (err) {
    throw new Error(explicar(err));
  }
}

// txid: 26 a 35 alfanuméricos, sem traço nem pontuação. Vai o número do título
// (ajuda a reconhecer no extrato) + aleatório, porque o mesmo título pode ter
// uma cobrança cancelada e outra nova, e txid não se repete.
function novoTxid({ numero, parcela }) {
  const base = ('GN' + String(numero || '').replace(/\W/g, '') + String(parcela || '').replace(/\W/g, ''))
    .toUpperCase().slice(0, 16);
  const sal = crypto.randomBytes(16).toString('hex').toUpperCase();
  return (base + sal).replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

module.exports = {
  configurado, criarCobv, consultarCobv, cancelarCobv, listarRecebidos, novoTxid,
  simulando: () => CFG().simular
};

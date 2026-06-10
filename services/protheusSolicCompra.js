// Wrapper pro endpoint REST custom Diego "SolicCompra/incluir".
// Spec validada em 2026-05-13: 8/10 testes PASS — caminho de validacao +
// sucesso ja funciona; falta dev tratar produto inexistente como
// inconsistencia (hoje quebra com 500).
//
// Endpoint: POST {PROTHEUS_API_URL}/SolicCompra/incluir
// Auth:     Basic admin:Gn@tu5 (mesmas creds do AprovaCompras / bordero)
// Timeout:  180s (operacao write — sem retry pra nao duplicar SC)
//
// Response (formato MIT072 padrao TOTVS):
//   sucesso       -> 200 { STATUS:{ATUALIZADOS,...}, INCONSISTENCIAS:[], SC_GERADAS:["099823"] }
//   item invalido -> 200 { STATUS:{NAO_ATUALIZADOS:N}, INCONSISTENCIAS:[{item,codigo_erro,mensagem}], SC_GERADAS:[] }
//   validacao     -> 400 { STATUS:{...}, INCONSISTENCIAS:[{codigo_erro,mensagem}], SC_GERADAS:[] }
//   erro sistema  -> 500 / timeout / sem resposta JSON
//   sem licenca   -> 503 { message: "Nao existe licenca disponivel no License Server..." }
//
// RETRY: o 503 do License Server (licenca esgotada) e RECUSADO ANTES de processar,
// entao NAO cria SC -> e seguro retentar 1x apos um curto delay. Timeout (504) e
// erro 500 NAO sao reententados (a SC pode ter sido criada e duplicaria).

// Timeout maior pq anexos podem inflar payload (10MB base64 = ~13MB no fio + processing AdvPL)
const TIMEOUT_MS = 180000;
const RETRY_MAX = 1;        // 1 retry (2 tentativas no total)
const RETRY_DELAY_MS = 2500;

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Cria SC no Protheus via REST custom Diego. Opcionalmente envia anexos
 * (grava em AC9010/ACB010 — "Conhecimento" no Protheus).
 *
 * @returns {Promise<{httpStatus, body, status, sc_numero, mensagem, duracao_ms, anexos_gravados, tentativas, motivo}>}
 *   status: 'SUCESSO' | 'REJEITADA' | 'ERRO_SISTEMA'
 *   motivo: 'LICENCA' | 'INDISPONIVEL' | 'TIMEOUT' | 'REDE' | 'CONFIG' | null
 */
async function criarSC({ filial, solicitante, data_emissao, data_necessaria, observacao, itens, anexos }) {
  const apiUrl  = process.env.PROTHEUS_API_URL;
  const apiUser = process.env.PROTHEUS_API_USER;
  const apiPass = process.env.PROTHEUS_API_PASS;
  const path    = process.env.PROTHEUS_API_PATH_SOLIC_COMPRA || '/SolicCompra/incluir';

  if (!apiUrl || !apiUser || !apiPass) {
    return {
      httpStatus: 503,
      body: { codigo_erro: 'CONFIG', mensagem: 'API Protheus nao configurada (.env PROTHEUS_API_URL/USER/PASS)' },
      status: 'ERRO_SISTEMA',
      sc_numero: null,
      mensagem: 'Backend mal configurado.',
      duracao_ms: 0,
      tentativas: 0,
      motivo: 'CONFIG'
    };
  }

  if (!Array.isArray(itens) || itens.length === 0) {
    return {
      httpStatus: 400,
      body: { INCONSISTENCIAS: [{ codigo_erro: 'SEM_ITENS', mensagem: 'Nenhum item informado.' }] },
      status: 'REJEITADA',
      sc_numero: null,
      mensagem: 'Nenhum item informado.',
      duracao_ms: 0,
      tentativas: 0,
      motivo: null
    };
  }

  const url = apiUrl.replace(/\/$/, '') + path;
  const auth = 'Basic ' + Buffer.from(`${apiUser}:${apiPass}`).toString('base64');

  const payload = {
    filial: trim(filial) || '01',
    solicitante: trim(solicitante),
    data_emissao: trim(data_emissao) || formatToday(),
    data_necessaria: trim(data_necessaria),
    observacao: trim(observacao),
    itens: itens.map(it => ({
      produto: trim(it.produto),
      quantidade: N(it.quantidade),
      local: trim(it.local) || '01',
      centro_custo: trim(it.centro_custo),
      observacao: trim(it.observacao),
      ...(trim(it.fornecedor) ? { fornecedor: trim(it.fornecedor), loja: trim(it.loja) || '01' } : {})
    })),
    ...(Array.isArray(anexos) && anexos.length > 0 ? {
      anexos: anexos.map(a => ({
        nome: trim(a.nome),
        descricao: trim(a.descricao) || trim(a.nome),
        base64: trim(a.base64),
        ...(a.item ? { item: N(a.item) } : {})
      }))
    } : {})
  };

  // Tenta + retry SÓ quando seguro (503 = licença/indisponivel, SC nao criada).
  let resultado;
  for (let tentativa = 1; tentativa <= RETRY_MAX + 1; tentativa++) {
    resultado = await executar(url, auth, payload);
    resultado.tentativas = tentativa;
    if (tentativa <= RETRY_MAX && resultado.retriable) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    break;
  }
  delete resultado.retriable;
  return resultado;
}

// Uma tentativa HTTP. Retorna o objeto interpretado (ou erro de rede/timeout).
async function executar(url, auth, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const inicio = Date.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const duracao_ms = Date.now() - inicio;
    const txt = await r.text();
    let body;
    try { body = JSON.parse(txt); }
    catch { body = { INCONSISTENCIAS: [{ codigo_erro: 'RESPOSTA_INVALIDA', mensagem: 'Resposta nao eh JSON.', raw: txt.slice(0, 500) }] }; }
    return interpretar(r.status, body, duracao_ms);
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    // Timeout/rede NAO sao retriable: a SC pode ter sido criada no Protheus.
    return {
      httpStatus: 504,
      body: {
        INCONSISTENCIAS: [{
          codigo_erro: isTimeout ? 'TIMEOUT' : 'ERRO_REDE',
          mensagem: isTimeout
            ? `Timeout apos ${TIMEOUT_MS / 1000}s aguardando resposta do Protheus`
            : `Falha de rede: ${err.message}`
        }]
      },
      status: 'ERRO_SISTEMA',
      sc_numero: null,
      mensagem: isTimeout ? 'Timeout aguardando Protheus' : `Falha de rede: ${err.message}`,
      duracao_ms: Date.now() - inicio,
      retriable: false,
      motivo: isTimeout ? 'TIMEOUT' : 'REDE'
    };
  }
}

// Interpreta o response no padrao Diego (MIT072 + INCONSISTENCIAS):
//   SC_GERADAS preenchido         -> SUCESSO
//   STATUS.NAO_ATUALIZADOS > 0    -> REJEITADA (item invalido — produto, qtd, etc)
//   resto                         -> ERRO_SISTEMA (HTTP 5xx, JSON quebrado)
function interpretar(httpStatus, body, duracao_ms) {
  const scs = Array.isArray(body?.SC_GERADAS) ? body.SC_GERADAS : [];
  const incs = Array.isArray(body?.INCONSISTENCIAS) ? body.INCONSISTENCIAS : [];
  const naoAtu = N(body?.STATUS?.NAO_ATUALIZADOS);
  const anexosGravados = N(body?.ANEXOS_GRAVADOS);

  if (scs.length > 0) {
    return {
      httpStatus, body, duracao_ms,
      status: 'SUCESSO',
      sc_numero: trim(scs[0]),
      anexos_gravados: anexosGravados,
      mensagem: null,
      retriable: false,
      motivo: null
    };
  }
  if (naoAtu > 0 || (incs.length > 0 && httpStatus < 500)) {
    return {
      httpStatus, body, duracao_ms,
      status: 'REJEITADA',
      sc_numero: null,
      anexos_gravados: 0,
      mensagem: incs[0]?.mensagem || `Rejeitada com ${naoAtu} inconsistencia(s).`,
      retriable: false,
      motivo: null
    };
  }

  // ERRO_SISTEMA — surfaca a mensagem do Diego (body.message) e trata 503/licenca.
  const msgRaw = trim(body?.message) || trim(incs[0]?.mensagem) || '';
  const semLicenca = /licen[çc]a|license\s*server/i.test(msgRaw);
  const indisponivel = httpStatus === 503;
  let mensagem, motivo;
  if (semLicenca) {
    mensagem = 'Protheus sem licença disponível no momento (License Server). Tente novamente em alguns instantes.';
    motivo = 'LICENCA';
  } else if (indisponivel) {
    mensagem = 'Protheus temporariamente indisponível (HTTP 503). Tente novamente em alguns instantes.';
    motivo = 'INDISPONIVEL';
  } else {
    mensagem = incs[0]?.mensagem || msgRaw || `Erro inesperado (HTTP ${httpStatus}).`;
    motivo = 'SISTEMA';
  }
  return {
    httpStatus, body, duracao_ms,
    status: 'ERRO_SISTEMA',
    sc_numero: null,
    anexos_gravados: 0,
    mensagem,
    // 503 (licenca/indisponivel) e recusado ANTES de processar -> SC nao criada -> seguro retentar.
    retriable: httpStatus === 503 && scs.length === 0,
    motivo
  };
}

function formatToday() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { criarSC };

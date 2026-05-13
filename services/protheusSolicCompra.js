// Wrapper pro endpoint REST custom Develsoft "SolicCompra/incluir".
// Spec validada em 2026-05-13: 8/10 testes PASS — caminho de validacao +
// sucesso ja funciona; falta dev tratar produto inexistente como
// inconsistencia (hoje quebra com 500).
//
// Endpoint: POST {PROTHEUS_API_URL}/SolicCompra/incluir
// Auth:     Basic admin:Gn@tu5 (mesmas creds do AprovaCompras / bordero)
// Timeout:  60s (operacao write — sem retry pra nao duplicar SC)
//
// Response (formato MIT072 padrao TOTVS):
//   sucesso       -> 200 { STATUS:{ATUALIZADOS,...}, INCONSISTENCIAS:[], SC_GERADAS:["099823"] }
//   item invalido -> 200 { STATUS:{NAO_ATUALIZADOS:N}, INCONSISTENCIAS:[{item,codigo_erro,mensagem}], SC_GERADAS:[] }
//   validacao     -> 400 { STATUS:{...}, INCONSISTENCIAS:[{codigo_erro,mensagem}], SC_GERADAS:[] }
//   erro sistema  -> 500 / timeout / sem resposta JSON

const TIMEOUT_MS = 60000;

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

/**
 * Cria SC no Protheus via REST custom Develsoft.
 *
 * @param {object} args
 * @param {string} args.filial            — '01'
 * @param {string} args.solicitante       — texto livre (vamos usar email do user)
 * @param {string} args.data_emissao      — 'YYYYMMDD' (default = hoje)
 * @param {string} args.data_necessaria   — 'YYYYMMDD' (obrigatorio)
 * @param {string} args.observacao        — texto livre
 * @param {Array}  args.itens             — [{produto, quantidade, local, centro_custo, observacao?, fornecedor?, loja?}]
 * @returns {Promise<{httpStatus, body, status, sc_numero, mensagem, duracao_ms}>}
 *   status: 'SUCESSO' | 'REJEITADA' | 'ERRO_SISTEMA'
 *   sc_numero: string|null     — preenchido em SUCESSO
 *   mensagem: string|null      — resumo curto do erro (em REJEITADA/ERRO_SISTEMA)
 */
async function criarSC({ filial, solicitante, data_emissao, data_necessaria, observacao, itens }) {
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
      duracao_ms: 0
    };
  }

  if (!Array.isArray(itens) || itens.length === 0) {
    return {
      httpStatus: 400,
      body: { INCONSISTENCIAS: [{ codigo_erro: 'SEM_ITENS', mensagem: 'Nenhum item informado.' }] },
      status: 'REJEITADA',
      sc_numero: null,
      mensagem: 'Nenhum item informado.',
      duracao_ms: 0
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
    }))
  };

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
      duracao_ms: Date.now() - inicio
    };
  }
}

// Interpreta o response no padrao Develsoft (MIT072 + INCONSISTENCIAS):
//   SC_GERADAS preenchido         -> SUCESSO
//   STATUS.NAO_ATUALIZADOS > 0    -> REJEITADA (item invalido — produto, qtd, etc)
//   resto                         -> ERRO_SISTEMA (HTTP 5xx, JSON quebrado)
function interpretar(httpStatus, body, duracao_ms) {
  const scs = Array.isArray(body?.SC_GERADAS) ? body.SC_GERADAS : [];
  const incs = Array.isArray(body?.INCONSISTENCIAS) ? body.INCONSISTENCIAS : [];
  const naoAtu = N(body?.STATUS?.NAO_ATUALIZADOS);

  if (scs.length > 0) {
    return {
      httpStatus, body, duracao_ms,
      status: 'SUCESSO',
      sc_numero: trim(scs[0]),
      mensagem: null
    };
  }
  if (naoAtu > 0 || (incs.length > 0 && httpStatus < 500)) {
    return {
      httpStatus, body, duracao_ms,
      status: 'REJEITADA',
      sc_numero: null,
      mensagem: incs[0]?.mensagem || `Rejeitada com ${naoAtu} inconsistencia(s).`
    };
  }
  return {
    httpStatus, body, duracao_ms,
    status: 'ERRO_SISTEMA',
    sc_numero: null,
    mensagem: incs[0]?.mensagem || `Erro inesperado (HTTP ${httpStatus}).`
  };
}

function formatToday() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { criarSC };

// Wrapper pro endpoint REST custom Diego "Cobranca/gerar-bordero".
// Spec validado em 2026-05-13: 10/10 cenarios PASS + echo da chave dos
// titulos no detalhes[].
//
// Endpoint: POST {PROTHEUS_API_URL}/Cobranca/gerar-bordero
// Auth:     Basic admin:Gn@tu5 (PROTHEUS_API_USER / PROTHEUS_API_PASS — mesmas
//           credenciais do AprovaCompras, lidas do .env)
// Timeout:  60s (operacao write — sem retry pra nao duplicar bordero)
// Limites:  ate 500 titulos por chamada (enforcado tambem no AdvPL)

const TIMEOUT_MS = 60000;

const trim = (v) => String(v || '').trim();

/**
 * Gera bordero no Protheus.
 *
 * @param {object} args
 * @param {string} args.filial      — '01'
 * @param {string} args.banco       — '341', '237', etc
 * @param {string} args.operador    — email do user que disparou
 * @param {string} args.observacao  — texto livre
 * @param {Array}  args.titulos     — [{prefixo, numero, parcela, tipo, cliente, loja}, ...]
 * @returns {Promise<{httpStatus, body, ok}>}
 */
async function gerarBordero({ filial, banco, agencia, conta, operador, observacao, titulos }) {
  const apiUrl  = process.env.PROTHEUS_API_URL;
  const apiUser = process.env.PROTHEUS_API_USER;
  const apiPass = process.env.PROTHEUS_API_PASS;
  const path    = process.env.PROTHEUS_API_PATH_BORDERO || '/Cobranca/gerar-bordero';

  if (!apiUrl || !apiUser || !apiPass) {
    return {
      httpStatus: 503,
      body: { ok: false, codigo_erro: 'CONFIG', mensagem: 'API Protheus nao configurada (.env PROTHEUS_API_URL/USER/PASS)' },
      ok: false
    };
  }

  if (!Array.isArray(titulos) || titulos.length === 0) {
    return {
      httpStatus: 400,
      body: { ok: false, codigo_erro: 'SEM_TITULOS', mensagem: 'Nenhum titulo informado.' },
      ok: false
    };
  }
  if (titulos.length > 500) {
    return {
      httpStatus: 400,
      body: { ok: false, codigo_erro: 'MUITOS_TITULOS', mensagem: `Quantidade de titulos (${titulos.length}) acima do limite de 500.` },
      ok: false
    };
  }

  const url = apiUrl.replace(/\/$/, '') + path;
  const auth = 'Basic ' + Buffer.from(`${apiUser}:${apiPass}`).toString('base64');

  const payload = {
    filial: trim(filial) || '01',
    banco: trim(banco),
    // Agencia/conta do portador escolhido (A6_AGENCIA / A6_NUMCON). Quando
    // informadas, a rotina deve gerar o bordero na carteira (SEE010) dessa conta
    // e setar E1_AGEDEP/E1_CONTA nos titulos. Sem elas, cai no comportamento
    // antigo (banco sem conta especifica).
    agencia: trim(agencia),
    conta: trim(conta),
    operador: trim(operador),
    observacao: trim(observacao),
    titulos: titulos.map(t => ({
      prefixo: trim(t.prefixo),
      numero:  trim(t.numero),
      parcela: trim(t.parcela),
      tipo:    trim(t.tipo) || 'NF',
      cliente: trim(t.cliente),
      loja:    trim(t.loja)
    }))
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    clearTimeout(timer);

    const txt = await r.text();
    let body;
    try { body = JSON.parse(txt); }
    catch { body = { ok: false, codigo_erro: 'RESPOSTA_INVALIDA', mensagem: 'Resposta do Protheus nao eh JSON.', raw: txt.slice(0, 500) }; }

    return { httpStatus: r.status, body, ok: r.ok && body?.ok === true };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    return {
      httpStatus: 504,
      body: {
        ok: false,
        codigo_erro: isTimeout ? 'TIMEOUT' : 'ERRO_REDE',
        mensagem: isTimeout
          ? `Timeout apos ${TIMEOUT_MS / 1000}s aguardando resposta do Protheus`
          : `Falha de rede: ${err.message}`
      },
      ok: false
    };
  }
}

module.exports = { gerarBordero };

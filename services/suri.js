// Cliente da API SURI (chatbot WhatsApp Business via Gupshup).
//
// Endpoint principal:
//   POST {SURI_API_URL}/messages/send
//   Authorization: Bearer {SURI_TOKEN}
//   Body: { user: { phone, channelId, channelType }, message: { templateId, BodyParameters[], ButtonsParameters[] } }
//
// Variaveis .env:
//   SURI_API_URL    — base da API (default: cbm-wap-babysuri-cb97032321-gnatu.azurewebsites.net/api)
//   SURI_TOKEN      — Bearer token perpetuo
//   SURI_CHANNEL_ID — id do canal WhatsApp (default: wp800236266508332 = "Gnatus")
//
// IDs internos dos templates de cobranca (formato cb97032321:template:NNNNNNN)
// vivem no .env tambem (SURI_TPL_*) pra facilitar troca sem deploy.

const axios = require('axios');

const BASE     = process.env.SURI_API_URL    || 'https://cbm-wap-babysuri-cb97032321-gnatu.azurewebsites.net/api';
const TOKEN    = process.env.SURI_TOKEN      || '';
const CHANNEL  = process.env.SURI_CHANNEL_ID || 'wp800236266508332';

const http = axios.create({
  baseURL: BASE,
  timeout: 15000,
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
});

// Templates de cobranca — IDs internos do SURI (sincronizados com Meta).
// Configuravel via .env (SURI_TPL_D1/D0/D3) caso precise trocar.
const TEMPLATES = {
  'D-1': process.env.SURI_TPL_D1 || 'cb97032321:template:152133702',  // cobrancalembreted1
  'D0':  process.env.SURI_TPL_D0 || 'cb97032321:template:152134356',  // cobrancavencimentod0
  'D+3': process.env.SURI_TPL_D3 || 'cb97032321:template:152140099',  // cobrancaatrasod3
  // envio_boleto (linha digitavel) — categoria Utility. So dispara se o env
  // estiver setado (sem default: ate aprovar/configurar fica desligado).
  'BOLETO': process.env.SURI_TPL_BOLETO || ''
};

// Body dos templates aprovados no Meta — espelhado aqui pra montar o preview
// renderizado (substituindo {{1}}, {{2}}…) sem precisar consultar o SURI.
// Mantido em sync com os textos efetivamente cadastrados.
const TEMPLATE_BODIES = {
  'D-1':
    'Olá, {{1}}!\n\nLembrete: amanhã ({{2}}) vence sua parcela da NF {{3}}, no valor de R$ {{4}}.\n\n' +
    'Se já efetuou o pagamento, por favor desconsidere esta mensagem.\n\nEquipe Financeiro Gnatus',
  'D0':
    'Olá, {{1}}!\n\nHoje vence sua parcela da NF {{2}}, no valor de R$ {{3}}.\n\n' +
    'Em caso de dúvidas sobre boleto ou pagamento, fale conosco.\n\nEquipe Financeiro Gnatus',
  'D+3':
    'Olá, {{1}}.\n\nIdentificamos que a parcela da NF {{2}} (R$ {{3}}, vencida em {{4}}) ainda não foi compensada.\n\n' +
    'Se já efetuou o pagamento, encaminhe o comprovante. Caso contrário, conte conosco para regularizar.\n\nEquipe Financeiro Gnatus',
  // {{1}} nome · {{2}} NF · {{3}} valor (sem R$) · {{4}} vencimento · {{5}} linha digitavel
  'BOLETO':
    'Olá, {{1}}!\n\nSegue o boleto referente à sua nota fiscal {{2}} na Gnatus.\n\n' +
    'Valor: R$ {{3}}\nVencimento: {{4}}\n\nLinha digitável:\n{{5}}\n\n' +
    'Copie a linha digitável acima e efetue o pagamento pelo app ou site do seu banco. Se já realizou o pagamento, desconsidere esta mensagem.'
};

// Substitui {{1}}, {{2}}, ... pelos valores. Usa replaceAll pra cobrir reuso.
function renderTemplate(tipo, parametros) {
  let body = TEMPLATE_BODIES[tipo] || '';
  (parametros || []).forEach((v, i) => {
    body = body.split(`{{${i + 1}}}`).join(v == null ? '' : String(v));
  });
  return body;
}

// Sanitiza parametros: SURI/Meta rejeitam string vazia em template.
const sanitize = (arr) => (Array.isArray(arr) ? arr : []).map(v => {
  const s = v == null ? '' : String(v);
  return s.trim() === '' ? ' ' : s;
});

// Normaliza telefone BR pra formato 55DDDNUMERO (so digitos).
// Aceita "(17) 99999-9999", "17 99999-9999", "5517999999999" etc.
// Retorna null se invalido (menos de 10 ou mais de 13 digitos uteis).
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;

  let phone = digits;
  if (phone.startsWith('00')) phone = phone.slice(2);     // 0055... -> 55...
  if (!phone.startsWith('55')) phone = '55' + phone;      // adiciona DDI Brasil

  // Apos o '55': DDD (2) + numero (8 fixo ou 9 movel) = 10 ou 11 digitos
  const local = phone.slice(2);
  if (local.length < 10 || local.length > 11) return null;

  return phone;
}

async function enviarTemplate({ phone, tipo, parameters }) {
  const templateId = TEMPLATES[tipo];
  if (!templateId) throw new Error(`Tipo de template invalido: ${tipo}`);

  const payload = {
    user: {
      phone,
      channelId: CHANNEL,
      channelType: 1
    },
    message: {
      templateId,
      BodyParameters: sanitize(parameters),
      ButtonsParameters: []
    }
  };

  try {
    const { data } = await http.post('/messages/send', payload);
    return {
      ok: data?.success === true,
      wamid: data?.data || null,
      raw: data
    };
  } catch (err) {
    const resp = err.response?.data;
    return {
      ok: false,
      wamid: null,
      erro: resp?.error || err.message,
      raw: resp || { message: err.message }
    };
  }
}

// Envio por templateId BRUTO (integracao Pipefy webhooks: os templates variam
// por pipe/fase e vivem no mapeamento de services/pipefyWebhook.js).
async function enviarTemplateId({ phone, templateId, parameters }) {
  const payload = {
    user: { phone, channelId: CHANNEL, channelType: 1 },
    message: { templateId, BodyParameters: sanitize(parameters), ButtonsParameters: [] }
  };
  try {
    const { data } = await http.post('/messages/send', payload);
    return { ok: data?.success === true, raw: data };
  } catch (err) {
    const resp = err.response?.data;
    return { ok: false, erro: resp?.error || err.message, raw: resp || { message: err.message } };
  }
}

module.exports = {
  enviarTemplate,
  enviarTemplateId,
  normalizePhone,
  renderTemplate,
  TEMPLATES,
  TEMPLATE_BODIES,
  CHANNEL_ID: CHANNEL
};

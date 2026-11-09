// services/cobrancaNotificacao.js — notificação formal ao cliente (protesto;
// Serasa entra quando houver template) por E-MAIL (caixa cobranca@) e WHATSAPP
// (template da Suri). Usado pelos endpoints cobranca.notificacao-*.
//
// Regras:
//   - Universo = mesmo da cobrança por WhatsApp: título em aberto, VENCIDO, só
//     Boleto Bancário (E1_FORMAPG='4'), sem RA/NCC, filial 01.
//   - E-mail: UM por cliente, com todos os títulos selecionados dele + quadro
//     "IMPORTANTE" com os outros vencidos que ainda não têm ordem de protesto
//     (status do título ≠ PROTESTO).
//   - WhatsApp: UMA mensagem por título (o template tem um título só).
//   - Trava: 1 envio por título × tipo × canal × dia (índice único parcial em
//     tab_cobranca_notificacao). A reserva é gravada ANTES de mandar, para a
//     tela que desiste por timeout não duplicar envio ao repetir.
//
// ⚠️ Exporta objeto (não função): o config/loader chama funções com `app`.

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

// Tipos de notificação. Para ligar Serasa: template aprovado na Suri + textos.
const TIPOS = {
  PROTESTO: {
    tipo: 'PROTESTO',
    label: 'Protesto',
    titulo: 'Notificação de protesto',
    statusOrdem: 'PROTESTO',      // status do título = "tem ordem de encaminhamento"
    suriTemplateId: () => trim(process.env.SURI_TPL_PROTESTO) || '1282862820695683'
  }
};
const tipoCfg = (tipo) => TIPOS[trim(tipo).toUpperCase()] || null;

// Texto do template cadastrado na Suri (id 1282862820695683) — espelho para a
// prévia. {{1}} nome · {{2}} pedido/título · {{3}} banco · {{4}} vencimento ·
// {{5}} valor (com R$) · {{6}} dias em atraso. Manter em sincronia com a Suri.
const WHATSAPP_BODY = {
  PROTESTO:
    'Olá, *{{1}}*.\n\n' +
    'Identificamos uma pendência financeira vinculada ao seu cadastro junto à *Gnatus Produtos Médicos e Odontológicos Ltda.*\n\n' +
    '*Informações do título:*\n\n' +
    '📄 *Pedido/Título:* {{2}}\n' +
    '🏦 *Banco:* {{3}}\n' +
    '📅 *Vencimento:* {{4}}\n' +
    '💰 *Valor em aberto:* {{5}}\n' +
    '⏳ *Dias em atraso:* {{6}}\n\n' +
    '⚠️ *IMPORTANTE – NOTIFICAÇÃO DE PROTESTO*\n\n' +
    'Informamos que o título acima poderá ser encaminhado para protesto junto ao Cartório competente.\n\n' +
    'Solicitamos a regularização do débito no prazo máximo de *48 horas úteis*, contadas a partir do recebimento desta notificação.\n\n' +
    'Caso tenha realizado o pagamento, solicitamos o envio do comprovante para atualização dos nossos registros.\n\n' +
    'Para propostas de negociação, esclarecimentos ou demais informações, entre em contato com nosso Departamento de Crédito e Cobrança pelo WhatsApp:\n\n' +
    '📲 https://wa.me/5517992242484\n\n' +
    '*Gnatus – Departamento de Crédito e Cobrança*'
};

// ---------------------------------------------------------------------------
// Banco do título. O portador (E1_PORTADO) nem sempre é banco: na carteira há
// FIDC/securitizadora (030, 037, 006…), conta transitória (TRA), caixa (CX1) e
// título sem portador. Só os códigos abaixo viram nome de banco automático.
// ---------------------------------------------------------------------------
const BANCOS = {
  '001': 'Banco do Brasil', '033': 'Santander', '104': 'Caixa Econômica Federal',
  '237': 'Bradesco', '341': 'Itaú', '422': 'Safra', '707': 'Daycoval',
  '748': 'Sicredi', '756': 'Sicoob'
};
// Portadores que não são banco mas cujo boleto sai num banco conhecido.
// Ficam como TERCEIRO (o operador vê o aviso), com o banco já sugerido.
const SUGESTAO_TERCEIRO = {
  '009': 'Banco do Brasil',   // BB descontadas
  '019': 'Daycoval',          // Daycoval descontadas
  '043': 'Santander',         // Santander descontadas
  '044': 'Bradesco',          // Acreditar FIDC (cessão; boleto no Bradesco)
  '699': 'Bradesco'           // BFC (cessão; boleto no Bradesco)
};
const SEM_BANCO = new Set(['', 'TRA', 'CX1']);

function classificarPortador({ portador, agencia, conta, nreduz, nome }) {
  const cod = trim(portador).toUpperCase();
  const nomePortador = trim(nreduz) || trim(nome) || cod || 'sem portador';
  const contaZerada = !trim(agencia).replace(/0/g, '') && !trim(conta).replace(/0/g, '');
  if (BANCOS[cod] && !contaZerada) {
    return { classe: 'BANCO', banco: BANCOS[cod], portadorNome: nomePortador };
  }
  if (SEM_BANCO.has(cod)) {
    return { classe: 'SEM_BANCO', banco: '', portadorNome: cod ? nomePortador : 'sem portador' };
  }
  return { classe: 'TERCEIRO', banco: SUGESTAO_TERCEIRO[cod] || '', portadorNome: nomePortador };
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------
const fmtData = (ymd) => {
  const s = trim(ymd).replace(/\D/g, '');
  return s.length === 8 ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : trim(ymd);
};
const fmtBRL = (v) => N(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDias = (d) => `${N(d)} dia${N(d) === 1 ? '' : 's'}`;
const numTitulo = (t) => `${trim(t.numero)}${trim(t.parcela) ? '/' + trim(t.parcela) : ''}`;
function fmtDocumento(cgc) {
  const d = trim(cgc).replace(/\D/g, '');
  if (d.length === 14) return { rotulo: 'CNPJ', valor: d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') };
  if (d.length === 11) return { rotulo: 'CPF', valor: d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') };
  return d ? { rotulo: 'CNPJ/CPF', valor: d } : null;
}
// "emitido pelo Banco Itaú" / "pelo Banco do Brasil" / "pela Caixa Econômica Federal"
function emitidoPor(banco) {
  const b = trim(banco);
  if (!b) return '';
  if (/^caixa/i.test(b)) return `emitido pela ${b}`;
  if (/^banco/i.test(b)) return `emitido pelo ${b}`;
  return `emitido pelo Banco ${b}`;
}
// Data de hoje em Brasília (a VPS roda em UTC) — 'YYYY-MM-DD'.
const hojeBR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

// A1_EMAIL pode trazer vários endereços separados por ';' ou ','.
const RE_EMAIL = /^[^\s@;,<>"']+@[^\s@;,<>"']+\.[^\s@;,<>"']+$/;
const emailsValidos = (raw) => [...new Set(
  trim(raw).split(/[;,\s]+/).map(s => s.trim().toLowerCase()).filter(s => RE_EMAIL.test(s))
)];

// Telefone: mesma regra do disparo de cobrança (scheduler.extrairTelefone).
function telefoneDe(row, Suri) {
  const dddCel = trim(row.dddcel).replace(/\D/g, '').replace(/^0+/, '');
  if (dddCel) {
    const p = Suri.normalizePhone(dddCel);
    if (p) return p;
  }
  const ddd = trim(row.ddd).replace(/\D/g, '').replace(/^0+/, '');
  const tel = trim(row.tel_fixo).replace(/\D/g, '');
  if (ddd && tel) return Suri.normalizePhone(ddd + tel);
  if (tel) return Suri.normalizePhone(tel);
  return null;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Chave do título (filial é sempre 01 no universo da cobrança).
const chaveTitulo = (t) => [t.prefixo, t.numero, t.parcela, t.tipo, t.cliente_cod, t.cliente_loja]
  .map(trim).join('|');
const chaveCliente = (t) => `${trim(t.cliente_cod)}|${trim(t.cliente_loja)}`;

// ---------------------------------------------------------------------------
// Protheus: títulos vencidos (boleto), com contato do cliente e portador.
// `clientes` = [{cod, loja}] restringe a busca (envio/prévia).
// ---------------------------------------------------------------------------
async function buscarVencidos(Protheus, { clientes } = {}) {
  const params = {};
  let filtroCli = '';
  if (Array.isArray(clientes) && clientes.length) {
    filtroCli = 'AND (' + clientes.map((c, i) => {
      params[`c${i}`] = trim(c.cod); params[`l${i}`] = trim(c.loja);
      return `(se1.E1_CLIENTE = @c${i} AND se1.E1_LOJA = @l${i})`;
    }).join(' OR ') + ')';
  }
  return Protheus.connectAndQuery(`
    SELECT
      RTRIM(se1.E1_FILIAL)  filial,
      RTRIM(se1.E1_PREFIXO) prefixo,
      RTRIM(se1.E1_NUM)     numero,
      RTRIM(se1.E1_PARCELA) parcela,
      RTRIM(se1.E1_TIPO)    tipo,
      RTRIM(se1.E1_CLIENTE) cliente_cod,
      RTRIM(se1.E1_LOJA)    cliente_loja,
      RTRIM(COALESCE(NULLIF(sa1.A1_NOME, ''), se1.E1_NOMCLI)) cliente_nome,
      RTRIM(sa1.A1_CGC)     cgc,
      RTRIM(sa1.A1_EMAIL)   email,
      RTRIM(sa1.A1_DDD)     ddd,
      RTRIM(sa1.A1_TEL)     tel_fixo,
      RTRIM(sa1.A1_DDDCEL)  dddcel,
      RTRIM(se1.E1_PORTADO) portador,
      RTRIM(se1.E1_AGEDEP)  agencia,
      RTRIM(se1.E1_CONTA)   conta,
      RTRIM(sa6.A6_NREDUZ)  portador_nreduz,
      RTRIM(sa6.A6_NOME)    portador_nome,
      se1.E1_VALOR          valor,
      se1.E1_SALDO          saldo,
      RTRIM(se1.E1_VENCREA) vencimento,
      DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, GETDATE())) dias_atraso
    FROM SE1010 se1 WITH (NOLOCK)
    LEFT JOIN SA1010 sa1 WITH (NOLOCK)
      ON sa1.A1_COD = se1.E1_CLIENTE AND sa1.A1_LOJA = se1.E1_LOJA AND sa1.D_E_L_E_T_ <> '*'
    OUTER APPLY (
      SELECT TOP 1 A6_NREDUZ, A6_NOME FROM SA6010 WITH (NOLOCK)
       WHERE A6_COD = se1.E1_PORTADO AND A6_AGENCIA = se1.E1_AGEDEP
         AND A6_NUMCON = se1.E1_CONTA AND D_E_L_E_T_ <> '*'
    ) sa6
    WHERE se1.D_E_L_E_T_ <> '*'
      AND se1.E1_FILIAL = '01'
      AND se1.E1_SALDO > 0
      AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
      AND RTRIM(se1.E1_FORMAPG) = '4'
      AND CONVERT(date, se1.E1_VENCREA, 112) < CONVERT(date, GETDATE())
      ${filtroCli}
    ORDER BY cliente_nome, se1.E1_CLIENTE, se1.E1_LOJA, se1.E1_VENCREA, se1.E1_NUM, se1.E1_PARCELA`,
    params
  );
}

// Linha do Protheus -> objeto de título usado pela tela e pelo envio.
function normalizar(row, Suri) {
  const port = classificarPortador({
    portador: row.portador, agencia: row.agencia, conta: row.conta,
    nreduz: row.portador_nreduz, nome: row.portador_nome
  });
  const t = {
    filial: trim(row.filial) || '01',
    prefixo: trim(row.prefixo), numero: trim(row.numero), parcela: trim(row.parcela),
    tipo: trim(row.tipo),
    cliente_cod: trim(row.cliente_cod), cliente_loja: trim(row.cliente_loja),
    cliente_nome: trim(row.cliente_nome),
    documento: fmtDocumento(row.cgc),
    emails: emailsValidos(row.email),
    email_bruto: trim(row.email),
    telefone: telefoneDe(row, Suri),
    portador: trim(row.portador),
    portador_nome: port.portadorNome,
    portador_classe: port.classe,
    banco: port.banco,
    valor: N(row.valor),
    saldo: N(row.saldo),
    vencimento: trim(row.vencimento),
    dias_atraso: N(row.dias_atraso)
  };
  t.chave = chaveTitulo(t);
  return t;
}

// ---------------------------------------------------------------------------
// PG: status de cobrança e histórico de notificações
// ---------------------------------------------------------------------------
async function statusTitulos(Pg) {
  const rows = await Pg.connectAndQuery(`
    SELECT cliente_cod, cliente_loja, titulo_prefixo, titulo_num, titulo_parcela, titulo_tipo, status, observacao
      FROM tab_cobranca_status_titulo`, {});
  const m = new Map();
  rows.forEach(r => m.set(chaveTitulo({
    prefixo: r.titulo_prefixo, numero: r.titulo_num, parcela: r.titulo_parcela, tipo: r.titulo_tipo,
    cliente_cod: r.cliente_cod, cliente_loja: r.cliente_loja
  }), { status: trim(r.status), observacao: r.observacao || '' }));
  return m;
}

async function statusClientes(Pg) {
  const rows = await Pg.connectAndQuery(
    `SELECT cliente_cod, cliente_loja, status FROM tab_cobranca_status_cliente`, {});
  const m = new Map();
  rows.forEach(r => m.set(chaveCliente(r), trim(r.status)));
  return m;
}

// Último envio OK (ou o último qualquer) por título × canal, para o tipo.
async function ultimasNotificacoes(Pg, tipo) {
  const rows = await Pg.connectAndQuery(`
    SELECT DISTINCT ON (prefixo, numero, parcela, tipo_titulo, cliente_cod, cliente_loja, canal)
           prefixo, numero, parcela, tipo_titulo, cliente_cod, cliente_loja, canal,
           status, criado_em, destino, erro
      FROM tab_cobranca_notificacao
     WHERE tipo = @tipo AND status <> 'ENVIANDO'
     ORDER BY prefixo, numero, parcela, tipo_titulo, cliente_cod, cliente_loja, canal,
              (status = 'OK') DESC, criado_em DESC`, { tipo });
  const m = new Map();
  rows.forEach(r => {
    const k = chaveTitulo({ ...r, tipo: r.tipo_titulo });
    const atual = m.get(k) || {};
    atual[trim(r.canal)] = { status: trim(r.status), em: r.criado_em, destino: r.destino, erro: r.erro };
    m.set(k, atual);
  });
  return m;
}

// Reserva marcada como ENVIANDO há mais de 15 min = processo caiu no meio.
// Vira ERRO para não travar o título pelo resto do dia.
async function liberarTravados(Pg) {
  await Pg.connectAndQuery(`
    UPDATE tab_cobranca_notificacao
       SET status = 'ERRO', erro = 'Envio interrompido (sem confirmação do servidor).', atualizado_em = NOW()
     WHERE status = 'ENVIANDO' AND criado_em < NOW() - INTERVAL '15 minutes'`, {});
}

// Grava a reserva (status ENVIANDO). Retorna o id, ou null se o título já foi
// notificado hoje neste canal (OK ou em andamento).
async function reservar(Pg, { tipo, canal, dia, titulo, destino, parametros, idUser, envioId }) {
  const r = await Pg.connectAndQuery(`
    INSERT INTO tab_cobranca_notificacao (
      tipo, canal, dia, filial, prefixo, numero, parcela, tipo_titulo,
      cliente_cod, cliente_loja, cliente_nome, valor, vencimento, dias_atraso, banco,
      destino, parametros, status, envio_id, id_user
    ) VALUES (
      @tipo, @canal, @dia::date, @filial, @prefixo, @numero, @parcela, @tipo_titulo,
      @cliente_cod, @cliente_loja, @cliente_nome, @valor::numeric, TO_DATE(@vencimento, 'YYYYMMDD'), @dias::int, @banco,
      @destino, @parametros::jsonb, 'ENVIANDO', @envio_id, @id_user::int
    )
    ON CONFLICT (tipo, canal, dia, filial, prefixo, numero, parcela, tipo_titulo, cliente_cod, cliente_loja)
      WHERE status IN ('ENVIANDO', 'OK')
    DO NOTHING
    RETURNING id`,
    {
      tipo, canal, dia,
      filial: titulo.filial || '01', prefixo: titulo.prefixo, numero: titulo.numero,
      parcela: titulo.parcela || '', tipo_titulo: titulo.tipo || '',
      cliente_cod: titulo.cliente_cod, cliente_loja: titulo.cliente_loja,
      cliente_nome: (titulo.cliente_nome || '').slice(0, 200),
      valor: N(titulo.saldo), vencimento: titulo.vencimento || null, dias: N(titulo.dias_atraso),
      banco: (titulo.banco || '').slice(0, 60),
      destino: (destino || '').slice(0, 500),
      parametros: parametros ? JSON.stringify(parametros) : null,
      envio_id: envioId, id_user: idUser || null
    }
  );
  return r.length ? r[0].id : null;
}

async function finalizar(Pg, ids, { status, erro, wamid, response }) {
  const lista = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!lista.length) return;
  const p = { status, erro: erro ? String(erro).slice(0, 2000) : null, wamid: wamid ? String(wamid).slice(0, 120) : null,
    resp: response ? JSON.stringify(response).slice(0, 20000) : null };
  const inIds = lista.map((id, i) => { p[`id${i}`] = id; return `@id${i}::int`; }).join(',');
  await Pg.connectAndQuery(`
    UPDATE tab_cobranca_notificacao
       SET status = @status, erro = @erro::text, wamid = @wamid::text,
           response_json = @resp::jsonb, atualizado_em = NOW()
     WHERE id IN (${inIds})`, p);
}

// ---------------------------------------------------------------------------
// Conteúdo
// ---------------------------------------------------------------------------
function parametrosWhatsapp(titulo, cliente) {
  return [
    trim(cliente.nome) || 'Cliente',
    numTitulo(titulo),
    trim(titulo.banco) || '—',
    fmtData(titulo.vencimento),
    fmtBRL(titulo.saldo),
    String(N(titulo.dias_atraso))
  ];
}

function textoWhatsapp(tipo, params) {
  let body = WHATSAPP_BODY[tipo] || '';
  params.forEach((v, i) => { body = body.split(`{{${i + 1}}}`).join(v == null ? '' : String(v)); });
  return body;
}

// Lista "087353/01, 087353/02 e 087353/03" (corta em 6: "… e mais N").
function listaTitulos(titulos) {
  const nums = titulos.map(numTitulo);
  if (nums.length <= 6) {
    return nums.length === 1 ? nums[0] : `${nums.slice(0, -1).join(', ')} e ${nums[nums.length - 1]}`;
  }
  return `${nums.slice(0, 5).join(', ')} e mais ${nums.length - 5}`;
}

const LOGO_URL = process.env.EMAIL_LOGO_URL || 'https://intranew.gnatus.com.br/logo-gnatus-email.png';

// E-mail no layout aprovado pela cobrança (HTML email-safe: tabelas + inline).
// `titulos` = os notificados; `outros` = vencidos do cliente sem ordem de protesto.
function montarEmail({ tipo, cliente, titulos, outros }) {
  const cfg = tipoCfg(tipo) || TIPOS.PROTESTO;
  const um = titulos.length === 1;
  const doc = cliente.documento;
  const assunto = um
    ? `${cfg.titulo} — Pedido/Título ${numTitulo(titulos[0])}`
    : `${cfg.titulo} — ${titulos.length} títulos em atraso`;

  const intro = um
    ? `Informamos que o título abaixo${titulos[0].banco ? ', ' + emitidoPor(titulos[0].banco) + ',' : ''} encontra-se em atraso e poderá ser encaminhado para protesto junto ao Cartório competente.`
    : 'Informamos que os títulos abaixo encontram-se em atraso e poderão ser encaminhados para protesto junto ao Cartório competente.';

  const linha = (rotulo, valor, primeira) => `<tr>
<td style="padding:11px 0;font-size:13px;color:#64748b;${primeira ? '' : 'border-top:1px solid #e2e8f0;'}">${esc(rotulo)}</td>
<td style="padding:11px 0;font-size:14px;color:#0f172a;font-weight:700;text-align:right;${primeira ? '' : 'border-top:1px solid #e2e8f0;'}">${esc(valor)}</td>
</tr>`;
  const bloco = (t, idx) => `${idx > 0 ? '<tr><td colspan="2" style="height:14px;line-height:14px;font-size:0;">&nbsp;</td></tr>' : ''}
${linha('Pedido / Título', numTitulo(t), idx === 0)}
${linha('Banco', t.banco || '—')}
${linha('Vencimento', fmtData(t.vencimento))}
${linha('Valor em aberto', fmtBRL(t.saldo))}
${linha('Dias de atraso', fmtDias(t.dias_atraso))}`;

  const tabela = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;">
${titulos.map((t, i) => bloco(t, i)).join('\n')}
</table>`;

  let importante = '';
  if (outros && outros.length) {
    const plural = outros.length > 1;
    const lista = listaTitulos(outros);
    const txt = plural
      ? `Os pedidos nº ${lista} também apresentam pendência financeira, porém, até o presente momento, não possuem ordem de encaminhamento para protesto. Recomendamos que essas pendências também sejam consideradas para regularização, a fim de evitar o agravamento da situação financeira.`
      : `O pedido nº ${lista} também apresenta pendência financeira, porém, até o presente momento, não possui ordem de encaminhamento para protesto. Recomendamos que essa pendência também seja considerada para regularização, a fim de evitar o agravamento da situação financeira.`;
    importante = `<tr><td style="padding:22px 32px 0 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#eef4fb;border-left:4px solid #1e5fb5;border-radius:6px;">
<tr>
<td valign="top" style="padding:16px 0 16px 16px;width:28px;">
<div style="width:24px;height:24px;line-height:24px;border-radius:12px;background:#1a3f82;color:#ffffff;font-weight:700;font-size:15px;text-align:center;">!</div>
</td>
<td valign="top" style="padding:16px 18px 16px 12px;font-size:13px;line-height:1.6;color:#1e293b;">
<div style="font-size:14px;font-weight:700;color:#1a3f82;margin-bottom:4px;">IMPORTANTE</div>
${esc(txt)}
</td>
</tr>
</table>
</td></tr>`;
  }

  const prazo = 'Caso não ocorra a identificação do pagamento dentro do prazo estabelecido, ' +
    (um ? 'o título será encaminhado' : 'os títulos serão encaminhados') +
    ' para protesto junto ao Cartório competente, além da adoção das demais medidas de cobrança cabíveis.';

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(assunto)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f5f9;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
<tr><td style="padding:28px 32px 4px 32px;">
<img src="${esc(LOGO_URL)}" alt="Gnatus" width="120" height="30" style="display:block;border:0;outline:none;text-decoration:none;width:120px;height:30px;margin-bottom:22px;">
<div style="font-size:12px;letter-spacing:1.6px;color:#64748b;text-transform:uppercase;font-weight:700;">Financeiro</div>
<h1 style="margin:6px 0 0 0;font-size:24px;line-height:1.3;font-weight:700;color:#1a2740;">${esc(cfg.titulo)}</h1>
</td></tr>
<tr><td style="padding:16px 32px 0 32px;">
<div style="font-size:16px;font-weight:700;color:#1a2740;">À ${esc(cliente.nome || 'empresa cliente')}</div>
${doc ? `<div style="font-size:13px;color:#334155;margin-top:4px;">${esc(doc.rotulo)}: ${esc(doc.valor)}</div>` : ''}
<p style="margin:12px 0 18px 0;font-size:14px;line-height:1.6;color:#1e293b;">${esc(intro)}</p>
</td></tr>
<tr><td style="padding:0 32px;">
${tabela}
</td></tr>
<tr><td style="padding:18px 32px 0 32px;font-size:14px;line-height:1.6;color:#1e293b;">
Solicitamos a regularização do débito <strong>no prazo máximo de 48 horas úteis</strong>, contadas a partir do recebimento desta notificação. ${esc(prazo)}
</td></tr>
${importante}
<tr><td style="padding:22px 32px 0 32px;font-size:14px;line-height:1.6;color:#1e293b;">
<p style="margin:0 0 12px 0;">Caso exista interesse em negociação, solicitamos que a proposta seja apresentada dentro do prazo informado, para avaliação do Departamento de Crédito e Cobrança.</p>
<p style="margin:0 0 18px 0;">Se o pagamento já tiver sido realizado, pedimos o envio do respectivo comprovante para atualização dos nossos registros.</p>
<p style="margin:0 0 4px 0;">Atenciosamente,</p>
<p style="margin:0;font-weight:700;color:#0f172a;">Departamento de Crédito e Cobrança</p>
<p style="margin:0 0 26px 0;color:#334155;">Gnatus Produtos Médicos e Odontológicos Ltda.</p>
</td></tr>
<tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:14px 32px;font-size:11px;color:#64748b;text-align:center;">
Este é um e-mail automático. Para atendimento, responda esta mensagem.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const texto =
    `${cfg.titulo.toUpperCase()}\n\nÀ ${cliente.nome || 'empresa cliente'}\n` +
    (doc ? `${doc.rotulo}: ${doc.valor}\n` : '') + `\n${intro}\n\n` +
    titulos.map(t =>
      `Pedido / Título: ${numTitulo(t)}\nBanco: ${t.banco || '—'}\nVencimento: ${fmtData(t.vencimento)}\n` +
      `Valor em aberto: ${fmtBRL(t.saldo)}\nDias de atraso: ${fmtDias(t.dias_atraso)}`).join('\n\n') +
    `\n\nSolicitamos a regularização do débito no prazo máximo de 48 horas úteis, contadas a partir do recebimento desta notificação. ${prazo}\n\n` +
    (outros && outros.length ? `IMPORTANTE: ${outros.length > 1 ? 'os pedidos' : 'o pedido'} nº ${listaTitulos(outros)} também ${outros.length > 1 ? 'apresentam' : 'apresenta'} pendência financeira, sem ordem de encaminhamento para protesto até o momento.\n\n` : '') +
    'Caso exista interesse em negociação, solicitamos que a proposta seja apresentada dentro do prazo informado, para avaliação do Departamento de Crédito e Cobrança.\n\n' +
    'Se o pagamento já tiver sido realizado, pedimos o envio do respectivo comprovante para atualização dos nossos registros.\n\n' +
    'Atenciosamente,\nDepartamento de Crédito e Cobrança\nGnatus Produtos Médicos e Odontológicos Ltda.';

  return { assunto, html, texto };
}

// Monta o pacote de um cliente: títulos escolhidos (validados) + outros vencidos.
// `linhas` = títulos normalizados do cliente vindos do Protheus.
// `escolhidos` = Map chave -> { banco? } pedidos pela tela.
function pacoteCliente({ tipo, linhas, escolhidos, statusTit }) {
  const cfg = tipoCfg(tipo) || TIPOS.PROTESTO;
  const titulos = [];
  const outros = [];
  linhas.forEach(t => {
    const pedido = escolhidos.get(t.chave);
    if (pedido) {
      const banco = trim(pedido.banco);
      titulos.push({ ...t, banco: banco ? banco.slice(0, 40) : t.banco });
    } else if ((statusTit.get(t.chave) || {}).status !== cfg.statusOrdem) {
      outros.push(t);
    }
  });
  const base = linhas[0] || {};
  const cliente = {
    cod: base.cliente_cod, loja: base.cliente_loja, nome: base.cliente_nome,
    documento: base.documento, emails: base.emails || [], telefone: base.telefone || null
  };
  return { cliente, titulos, outros };
}

// Recebe os títulos pedidos pela tela, RE-CONSULTA o Protheus (fonte da verdade:
// o título pode ter sido pago entre a lista e o envio) e devolve um pacote por
// cliente. `ignorados` = chaves que não estão mais em aberto/vencidas.
async function carregarPacotes({ Pg, Protheus, Suri }, tipo, titulosBody) {
  const escolhidosPorCli = new Map();   // chaveCliente -> Map(chaveTitulo -> { banco })
  for (const b of titulosBody || []) {
    const t = {
      prefixo: b && b.prefixo, numero: b && b.numero, parcela: b && b.parcela, tipo: b && b.tipo,
      cliente_cod: b && b.cliente_cod, cliente_loja: b && b.cliente_loja
    };
    if (!trim(t.numero) || !trim(t.cliente_cod) || !trim(t.cliente_loja)) continue;
    const ck = chaveCliente(t);
    if (!escolhidosPorCli.has(ck)) escolhidosPorCli.set(ck, new Map());
    escolhidosPorCli.get(ck).set(chaveTitulo(t), { banco: typeof b.banco === 'string' ? b.banco : '' });
  }
  if (!escolhidosPorCli.size) return { pacotes: [], ignorados: [] };

  const clientes = [...escolhidosPorCli.keys()].map(k => {
    const [cod, loja] = k.split('|');
    return { cod, loja };
  });
  const [rows, statusTit] = await Promise.all([
    buscarVencidos(Protheus, { clientes }),
    statusTitulos(Pg)
  ]);
  const linhasPorCli = new Map();
  rows.forEach(r => {
    const t = normalizar(r, Suri);
    const ck = chaveCliente(t);
    if (!linhasPorCli.has(ck)) linhasPorCli.set(ck, []);
    linhasPorCli.get(ck).push(t);
  });

  const pacotes = [];
  const ignorados = [];
  for (const [ck, escolhidos] of escolhidosPorCli) {
    const pac = pacoteCliente({ tipo, linhas: linhasPorCli.get(ck) || [], escolhidos, statusTit });
    const achados = new Set(pac.titulos.map(t => t.chave));
    for (const k of escolhidos.keys()) if (!achados.has(k)) ignorados.push(k);
    if (pac.titulos.length) pacotes.push(pac);
  }
  return { pacotes, ignorados };
}

// Em DEV o e-mail só é logado (emailService); o WhatsApp segue a mesma regra
// para teste local não mandar mensagem a cliente. NOTIF_WHATSAPP_DEV=1 libera.
const whatsappReal = () =>
  process.env.NODE_ENV === 'production' || process.env.NOTIF_WHATSAPP_DEV === '1';

async function enviarWhatsapp(Suri, tipo, { phone, parametros }) {
  const cfg = tipoCfg(tipo) || TIPOS.PROTESTO;
  if (!whatsappReal()) {
    console.log(`[cobrancaNotificacao] DEV — WhatsApp ${cfg.tipo} para ${phone}: ${JSON.stringify(parametros)}`);
    return { ok: true, dev: true, wamid: null, raw: { dev: true } };
  }
  const r = await Suri.enviarTemplateId({ phone, templateId: cfg.suriTemplateId(), parameters: parametros });
  const d = r && r.raw && r.raw.data;
  const wamid = typeof d === 'string' ? d : (d && (d.wamid || d.id)) || null;
  const erro = r.ok ? null : (typeof r.erro === 'string' ? r.erro : JSON.stringify(r.erro || r.raw || 'falha no envio'));
  return { ok: !!r.ok, wamid, erro, raw: r.raw };
}

module.exports = {
  carregarPacotes, enviarWhatsapp, whatsappReal,
  TIPOS, tipoCfg, WHATSAPP_BODY,
  buscarVencidos, normalizar, classificarPortador,
  statusTitulos, statusClientes, ultimasNotificacoes,
  liberarTravados, reservar, finalizar,
  parametrosWhatsapp, textoWhatsapp, montarEmail, pacoteCliente,
  emailsValidos, chaveTitulo, chaveCliente, numTitulo, fmtBRL, fmtData, hojeBR
};

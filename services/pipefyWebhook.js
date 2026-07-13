// services/pipefyWebhook.js — processa webhooks do Pipefy DENTRO da intranet.
// Porte fiel do webhook_gnatus.php da vm-pipefy (quebrado desde 24/04):
//   - SAC Atendimento (304770705): card.create/move -> WhatsApp pro CLIENTE
//   - Admissao Digital (304804154) fase Coleta de Documentacao -> WhatsApp pro colaborador
//   - Mapa fase->campo "responsavel": move/create -> WhatsApp pro RESPONSAVEL interno
//     (resolvido na tabela Pipefy 306929792, title = id do usuario, campo whatsapp);
//     card.late tambem notifica e inclui a gerente Patricia (305322776)
//   - G-CARE INTERNO (307050389): 4 fases notificam o CLIENTE (tabela CLIENTES)
//   - Teste_TI (306929743): branch de teste preservado
// Envio: services/suri (mesma API/canal do PHP). Fila com dedupe em
// tab_pipefy_wh_fila (numero+card+fase+acao), eventos em tab_pipefy_wh_evento.

const Suri = require('./suri');

const TOKEN = () => String(process.env.PIPEFY_TOKEN || '').trim();

// ---------- ids/portados do PHP ----------
const PIPE_SAC = '304770705';
const PIPE_GCARE = '307050389';
const PIPE_TESTE = '306929743';
const FASE_ADMISSAO_COLETA = '329019449';
const TABELA_USUARIOS_WHATS = '306929792';   // title = id do usuario -> campo whatsapp
const PATRICIA_ID = '305322776';             // gerente que monitora cards atrasados

const TPL = {
  SAC_CREATE: '2431775010589960',
  SAC_MOVE: '725692090306896',
  ADMISSAO: '883178097654718',
  RESP_MOVE: '1120671606709235',
  RESP_LATE: '1645337576894229'
};

// fase -> campo do responsavel (copiado 1:1 do PHP)
const MAPA_FASE_RESPONSAVEL = {
  // 03 | RELATORIO DE NAO CONFORMIDADE (304292510)
  '325975616': 'detremine_o_respons_vel_pela_a_o_de_corre_o',
  '325975617': 'selecione_um_respons_vel_pela_investiga_o_da_n_o_conformidade',
  // 02 | ATENDIMENTO AO CONSUMIDOR (304770705)
  '328814466': 'respons_vel_pelo_escalonamento',
  '328814467': 'respons_vel_pela_an_lise',
  '328814713': 'respons_vel_pelo_plano_de_a_o',
  '328814468': 'respons_vel_pela_verifica_o',
  // 05 | PROCESSO DE TROCA (304866308)
  '329400362': 'respons_vel',
  '329402427': 'respons_vel_2',
  '337258329': 'respons_vel_pela_aprova_o',
  '329400358': 'respons_vel_pela_libera_o',
  '329400359': 'respons_vel_pela_separa_o',
  '329400363': 'respons_vel_pela_libera_o_1',
  '329400360': 'respons_vel_pelo_faturamento',
  '329400361': 'respons_vel_pela_expedi_o',
  '329402982': 'respons_vel_pelo_acompanhamento',
  // 06 | PROCESSO DE DEVOLUCAO (304912650)
  '329679625': 'respons_vel',
  '333104196': 'respons_vel_5',
  '329679626': 'respons_vel_2',
  '329679379': 'respons_vel_pela_triagem',
  '329679380': 'respons_vel_pela_an_lise_e_aprova_o',
  '329679381': 'respons_vel_pelo_acompanhamento',
  '329679386': 'respons_vel_pelo_acompanhamento_1',
  '329679382': 'respons_vel_pelo_faturamento',
  '329679383': 'respons_vel_pela_coleta',
  '329679385': 'respons_vel_pelo_acompanhamento_2',
  '333933407': 'respons_vel_6',
  '329692383': 'respons_vel_1',
  '332294145': 'respons_vel_4',
  '329692861': 'respons_vel_3',
  // 18 | JURIDICO SAC (305698109)
  '334016083': 'respons_vel',
  // 25 | G-CARE INTERNO (307050389)
  '342679685': 'respons_vel_1',
  '342527973': 'respons_vel_pelo_or_amento',
  '342647575': 'respons_vel',
  '342564113': 'respons_vel_2',
  '342527983': 'respons_vel_pela_an_lise',
  '342679712': 'respons_vel_3',
  '342679717': 'respons_vel_5'
};

// G-CARE: fases que notificam o CLIENTE (template + builder de parametros)
const FASES_CLIENTES_GCARE = {
  '342679685': { templateId: '1289814069144901', builder: buildEntradaFiscalParams },   // ENTRADA FISCAL
  '342527982': { templateId: '1274682047953977', builder: buildOrcamentoParams },       // APROVACAO DO ORCAMENTO
  '342564106': { templateId: '1462330982253878', builder: buildPagamentoParams },       // AGUARDANDO PAGAMENTO
  '342527971': { templateId: '2059375837972044', builder: buildConcluidoParams }        // CONCLUIDO
};

// ====================== G-CARE NOVO (24 | G-CARE, 306859922) ======================
// Espelha os E-MAILS DE FASE (automacoes do Pipefy) como WhatsApp via Suri.
// Templates aprovados no Meta ficam em env (SURI_TPL_GCARE_*); enquanto vazios,
// NAO dispara (skip com log) — mesma logica do SURI_TPL_BOLETO. Textos p/ cadastro
// em docs/spec-whatsapp-gcare.md. Campos/conectores validados ao vivo (start form
// 341351610): cliente(nome_fantasia/telefone), ATA(nome_fantasia/telefone/e_mail),
// tecnico(nome_completo), telefone_whatsapp, tipo_de_atendimento,
// data_e_hora_agendada_para_o_servi_o, ordem_de_servi_o_n.
const PIPE_GCARE_NOVO = '306859922';

const TPL_GCARE = {
  protocolo:       process.env.SURI_TPL_GCARE_PROTOCOLO       || '',   // card criado -> cliente
  orcamento:       process.env.SURI_TPL_GCARE_ORCAMENTO       || '',   // aprovacao do orcamento -> cliente
  validacao:       process.env.SURI_TPL_GCARE_VALIDACAO       || '',   // validacao/avaliacao -> cliente
  concluido:       process.env.SURI_TPL_GCARE_CONCLUIDO       || '',   // concluido -> cliente
  agendamento:     process.env.SURI_TPL_GCARE_AGENDAMENTO     || '',   // mudanca de agenda -> cliente
  troca_tecnico:   process.env.SURI_TPL_GCARE_TROCA_TECNICO   || '',   // troca de tecnico -> cliente
  solic_pagamento: process.env.SURI_TPL_GCARE_SOLIC_PAGAMENTO || '',   // solicitacao pagamento -> ATA
  os_reprovada:    process.env.SURI_TPL_GCARE_OS_REPROVADA    || ''    // OS reprovada pelo cliente -> ATA
};

// card.create -> protocolo (cliente)
const GCARE_CREATE = {
  tpl: 'protocolo', destino: 'cliente',
  params: (c) => [c.cliNome, c.os, c.tipoServico, c.dataAgendada, c.tecNome, c.ataFone]
};
// card.move -> fase de destino (id) -> config
const GCARE_MOVE = {
  '341608830': { tpl: 'orcamento', destino: 'cliente',                  // APROVACAO DO ORCAMENTO
    params: async (c, id) => [c.cliNome, c.os, await publicFormLink(id), c.ataFone] },
  '341356572': { tpl: 'validacao', destino: 'cliente',                  // VALIDACAO E APROVACAO DO CLIENTE
    params: async (c, id) => [c.cliNome, c.os, c.tipoServico, await publicFormLink(id)] },
  '341351613': { tpl: 'concluido', destino: 'cliente',                  // CONCLUIDO
    params: (c) => [c.cliNome, c.os, c.ataFone, c.ataNome] },
  '341437387': { tpl: 'solic_pagamento', destino: 'ata',               // SOLICITACAO DE PAGAMENTO
    params: async (c, id) => [c.ataNome, c.os, await publicFormLink(id)] },
  '341753703': { tpl: 'os_reprovada', destino: 'ata',                  // ORDEM DE SERVICO REPROVADA PELO CLIENTE
    params: async (c, id) => [c.ataNome, c.os, c.tecNome, await publicFormLink(id)] }
};
// card.field_update -> por slug do campo alterado (nao ha move de fase)
const GCARE_FIELD_TRIGGERS = {
  'data_e_hora_agendada_para_o_servi_o': { tpl: 'agendamento', destino: 'cliente',
    params: (c) => [c.cliNome, c.os, c.dataAgendada, c.ataFone, c.ataNome] },
  't_cnico_respons_vel': { tpl: 'troca_tecnico', destino: 'cliente',
    params: (c) => [c.cliNome, c.tipoServico, c.os, c.tecNome, c.ataFone, c.ataNome] }
};

// ---- pré-filtro (economia de API) ----
// Só estas ações têm branch. Qualquer outra (field_update, done, comment...) é
// descartada ANTES de consultar o card, evitando 1 chamada dadosCard por evento.
const ACOES_TRATADAS = new Set(['card.create', 'card.move', 'card.late', 'card.field_update']);
// Pipes "fase-gated": só notificam em FASES mapeadas (responsável/cliente). SAC e
// Teste notificam em QUALQUER create/move → NÃO entram aqui (nunca são pulados).
// Hash do pipe_id no payload do webhook. Override por env PIPEFY_WH_PIPES_FASE_GATED.
// Default = pipes já observados: iB1LS8UH=G-Care, r8wZle0r=Trocas,
// ECJpQJ_y=Devolução, 28uoVqD5=Não Conformidade.
const PIPES_FASE_GATED = new Set(
  String(process.env.PIPEFY_WH_PIPES_FASE_GATED || 'iB1LS8UH,r8wZle0r,ECJpQJ_y,28uoVqD5')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

const trim = (v) => String(v == null ? '' : v).trim();

// ---------- GraphQL ----------
async function gql(query, variables) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch('https://api.pipefy.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN()}` },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.errors) throw new Error(`Pipefy: ${j.errors ? j.errors.map(e => e.message).join('; ') : 'HTTP ' + r.status}`);
    return j.data;
  } catch (e) { clearTimeout(timer); throw e; }
}

async function dadosCard(cardId) {
  const d = await gql(`query($id: ID!) { card(id: $id) {
    id title pipe { id } current_phase { id name }
    fields { name value array_value field { id } } } }`, { id: cardId });
  return d.card;
}
async function dadosDatabasePorId(recordId) {
  const d = await gql(`query($id: ID!) { table_record(id: $id) {
    id title record_fields { value field { id } } } }`, { id: recordId });
  return d.table_record;
}
// busca whatsapp do usuario na tabela 306929792 (title = id do usuario)
async function whatsappDoUsuario(idUsuario) {
  const d = await gql(`query($t: ID!, $s: String!) {
    table_records(table_id: $t, first: 1, search: { title: $s }) {
      edges { node { record_fields { value field { id } } } } } }`,
    { t: TABELA_USUARIOS_WHATS, s: String(idUsuario) });
  const fields = d.table_records?.edges?.[0]?.node?.record_fields || [];
  const f = fields.find(x => x.field.id === 'whatsapp');
  return f ? String(f.value || '').replace(/\D/g, '') : null;
}
async function publicFormLink(cardId) {
  try {
    const d = await gql(`mutation($id: ID!) {
      configurePublicPhaseFormLink(input: { cardId: $id, enable: true }) { url } }`, { id: Number(cardId) });
    return trim(d.configurePublicPhaseFormLink?.url);
  } catch (e) { return ''; }
}

// ---------- helpers de campos ----------
const valorCampo = (card, id) => { const f = (card.fields || []).find(x => x.field.id === id); return f ? f.value : null; };
const arrayCampo = (card, id) => { const f = (card.fields || []).find(x => x.field.id === id); return (f && Array.isArray(f.array_value)) ? f.array_value : []; };
const valorRecord = (fields, id) => { const f = (fields || []).find(x => x.field.id === id); return f ? f.value : null; };

// telefone como o PHP: digitos; 11 digitos -> prefixa 55; exige 13 no fim
function fonePHP(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (n.length === 11) n = '55' + n;
  return n.length === 13 ? n : null;
}

// builders G-CARE (porte 1:1)
function buildEntradaFiscalParams(card, clienteFields, cardId) {
  return [valorRecord(clienteFields, 'nome_fantasia'), cardId, valorCampo(card, 'tipo_de_manuten_o'),
    valorCampo(card, 'selecione_o_equipamento'), valorCampo(card, 'informe_o_n_mero_de_s_rie'), cardId];
}
async function buildOrcamentoParams(card, clienteFields, cardId) {
  return [valorRecord(clienteFields, 'nome_fantasia'), cardId, await publicFormLink(cardId)];
}
async function buildPagamentoParams(card, clienteFields, cardId) {
  return [valorRecord(clienteFields, 'nome_fantasia'), cardId,
    valorCampo(card, 'inserir_o_link_para_pagamento_via_cart_o_de_cr_dito'), await publicFormLink(cardId)];
}
async function buildConcluidoParams(card, clienteFields, cardId) {
  const base = [valorRecord(clienteFields, 'nome_fantasia'), cardId,
    valorCampo(card, 'selecione_o_equipamento'), valorCampo(card, 'informe_o_n_mero_de_s_rie')];
  const ids = arrayCampo(card, 'assist_ncia_t_cnica_autorizada');
  if (ids.length) {
    const at = await dadosDatabasePorId(ids[0]);
    return [...base, valorRecord(at.record_fields, 'telefone'), valorRecord(at.record_fields, 'nome_fantasia')];
  }
  return base;
}

// ---------- contexto G-CARE NOVO (resolve conectores 1x por evento) ----------
async function gcareContexto(card) {
  const os = trim(valorCampo(card, 'ordem_de_servi_o_n')) || trim(card.title);
  const tipoServico = trim(valorCampo(card, 'tipo_de_atendimento'));
  const dataAgendada = trim(valorCampo(card, 'data_e_hora_agendada_para_o_servi_o'));

  // CLIENTE: fone direto do card (telefone_whatsapp); nome/fallback fone no conector
  let cliNome = '', cliFone = trim(valorCampo(card, 'telefone_whatsapp'));
  const cliIds = arrayCampo(card, 'cliente');
  if (cliIds.length) {
    try {
      const r = await dadosDatabasePorId(cliIds[0]);
      cliNome = trim(valorRecord(r.record_fields, 'nome_fantasia')) || trim(valorRecord(r.record_fields, 'nome'));
      if (!cliFone) cliFone = trim(valorRecord(r.record_fields, 'telefone'));
    } catch (e) { /* segue com o que tem */ }
  }

  // ATA (assistencia tecnica autorizada)
  let ataNome = '', ataFone = '';
  const ataIds = arrayCampo(card, 'assist_ncia_t_cnica_autorizada');
  if (ataIds.length) {
    try {
      const r = await dadosDatabasePorId(ataIds[0]);
      ataNome = trim(valorRecord(r.record_fields, 'nome_fantasia')) || trim(valorRecord(r.record_fields, 'raz_o_social'));
      ataFone = trim(valorRecord(r.record_fields, 'telefone'));
    } catch (e) { /* segue */ }
  }

  // TECNICO responsavel
  let tecNome = '';
  const tecIds = arrayCampo(card, 't_cnico_respons_vel');
  if (tecIds.length) {
    try {
      const r = await dadosDatabasePorId(tecIds[0]);
      tecNome = trim(valorRecord(r.record_fields, 'nome_completo'));
    } catch (e) { /* segue */ }
  }

  return { os, tipoServico, dataAgendada, cliNome, cliFone, ataNome, ataFone, tecNome };
}

// ---------- fila (dedupe identico ao PHP) ----------
async function enfileirar(Pg, { fone, cardId, faseId, action, templateId, parametros }) {
  if (!fone) return false;
  try {
    const r = await Pg.connectAndQuery(
      `INSERT INTO tab_pipefy_wh_fila (numero_telefone, card_id, fase_id, card_action, template_id, parametros)
       VALUES (@n, @c, @f, @a, @t, @p)
       ON CONFLICT (numero_telefone, card_id, COALESCE(fase_id,''), COALESCE(card_action,'')) DO NOTHING
       RETURNING id`,
      { n: fone, c: String(cardId), f: faseId || null, a: action || null, t: templateId, p: (parametros || []).map(v => v == null ? '' : String(v)).join('|') });
    return r.length > 0;
  } catch (e) { console.warn('[pipefy-wh] enfileirar:', e.message); return false; }
}

async function processarFila(Pg) {
  const pend = await Pg.connectAndQuery(
    `SELECT id, numero_telefone, template_id, parametros FROM tab_pipefy_wh_fila WHERE enviado = '' ORDER BY id LIMIT 50`, {});
  let ok = 0, falha = 0;
  for (const item of pend) {
    let resp;
    try {
      resp = await Suri.enviarTemplateId({
        phone: trim(item.numero_telefone),
        templateId: trim(item.template_id),
        parameters: String(item.parametros || '').split('|')
      });
    } catch (e) { resp = { ok: false, erro: e.message }; }
    if (resp.ok) ok++; else falha++;
    await Pg.connectAndQuery(
      `UPDATE tab_pipefy_wh_fila SET enviado = @e, resposta = @r, enviado_em = NOW() WHERE id = @id`,
      { e: resp.ok ? '1' : '0', r: JSON.stringify(resp.raw || resp.erro || '').slice(0, 800), id: item.id });
  }
  return { ok, falha };
}

// ---------- processamento principal (porte do webhook_gnatus.php) ----------
async function processarEvento({ Pg }, payload) {
  const d = payload?.data || {};
  const action = trim(d.action);
  const cardId = trim(d.card?.id);
  let faseId = trim(d.to?.id) || trim(d.on_phase?.id);
  const faseNome = trim(d.to?.name);
  const acoes = [];

  if (!cardId) return { acoes: ['payload sem card id — ignorado'] };

  // Pré-filtro SEM chamar a API (conservador: na dúvida, processa):
  //  - ação sem branch → ignora;
  //  - move num pipe fase-gated para fase que não dispara nada → ignora.
  // SAC/Teste (notificam em todo move) e pipes desconhecidos seguem processando.
  if (!ACOES_TRATADAS.has(action)) return { acoes: [`ação "${action || '?'}" não tratada — ignorado (sem API)`] };
  const pipeHash = trim(d.card?.pipe_id);
  if (action === 'card.move' && faseId && PIPES_FASE_GATED.has(pipeHash)
      && !MAPA_FASE_RESPONSAVEL[faseId] && !FASES_CLIENTES_GCARE[faseId] && !GCARE_MOVE[faseId]) {
    return { acoes: [`fase ${faseId} sem gatilho no pipe ${pipeHash} — ignorado (sem API)`] };
  }
  // field_update: só interessa aos 2 campos-gatilho do G-Care novo — qualquer
  // outro é descartado ANTES da API (field_update é evento frequente).
  if (action === 'card.field_update' && !GCARE_FIELD_TRIGGERS[trim(d.field?.id)]) {
    return { acoes: [`field_update em "${trim(d.field?.id) || '?'}" sem gatilho — ignorado (sem API)`] };
  }

  const card = await dadosCard(cardId);
  const pipeId = trim(card?.pipe?.id);
  if (!faseId) faseId = trim(card?.current_phase?.id);

  // 1) SAC Atendimento — notifica o CLIENTE no create/move
  if (pipeId === PIPE_SAC && (action === 'card.create' || action === 'card.move')) {
    const nome = trim(valorCampo(card, 'nome_completo'));
    const fone = fonePHP(valorCampo(card, 'informe_seu_n_mero_de_telefone_whatsapp'));
    const tpl = action === 'card.create' ? TPL.SAC_CREATE : TPL.SAC_MOVE;
    const params = action === 'card.create' ? [nome, cardId] : [nome, cardId, faseNome];
    if (await enfileirar(Pg, { fone, cardId, faseId, action, templateId: tpl, parametros: params })) acoes.push(`SAC cliente ${fone}`);
  }

  // 2) Admissao Digital — fase Coleta de Documentacao
  if (faseId === FASE_ADMISSAO_COLETA && action === 'card.move') {
    const url = await publicFormLink(cardId);
    const params = [
      valorCampo(card, 'nome_do_a_colaborador_a'), valorCampo(card, 'selecione_o_cargo'),
      valorCampo(card, 'modalidade_de_trabalho'), valorCampo(card, 'data_de_in_cio_do_a_colaborador_a_1'),
      valorCampo(card, 'sal_rio_1'), valorCampo(card, 'anexar_carta_de_exame_admissional'),
      valorCampo(card, 'carta_para_abertura_de_conta_no_ita'), url
    ];
    const fone = fonePHP(valorCampo(card, 'telefone_do_a_colaborador_a'));
    if (await enfileirar(Pg, { fone, cardId, faseId, action, templateId: TPL.ADMISSAO, parametros: params })) acoes.push(`Admissão colaborador ${fone}`);
  }

  // 3) Responsaveis internos (mapa fase -> campo)
  const campoResp = MAPA_FASE_RESPONSAVEL[faseId];
  if (campoResp && (action === 'card.move' || action === 'card.create' || action === 'card.late')) {
    const url = `https://app.pipefy.com/open-cards/${cardId}`;
    const late = action === 'card.late';
    const tpl = late ? TPL.RESP_LATE : TPL.RESP_MOVE;
    const params = late ? [url] : [cardId, url];
    const ids = arrayCampo(card, campoResp).map(String);
    if (late && !ids.includes(PATRICIA_ID)) ids.push(PATRICIA_ID);
    for (const idUsuario of ids) {
      try {
        const fone = fonePHP(await whatsappDoUsuario(idUsuario));
        if (await enfileirar(Pg, { fone, cardId, faseId, action, templateId: tpl, parametros: params })) acoes.push(`responsável ${idUsuario} -> ${fone}`);
      } catch (e) { acoes.push(`responsável ${idUsuario}: ERRO ${e.message}`); }
    }
  }

  // 4) G-CARE — fases que notificam o CLIENTE
  const cfgGcare = FASES_CLIENTES_GCARE[faseId];
  if (pipeId === PIPE_GCARE && cfgGcare && (action === 'card.move' || action === 'card.create')) {
    for (const idCliente of arrayCampo(card, 'cliente')) {
      try {
        const cli = await dadosDatabasePorId(idCliente);
        const fone = fonePHP(valorRecord(cli.record_fields, 'telefone'));
        const params = await cfgGcare.builder(card, cli.record_fields, cardId);
        if (await enfileirar(Pg, { fone, cardId, faseId, action, templateId: cfgGcare.templateId, parametros: params })) acoes.push(`G-Care cliente ${fone}`);
      } catch (e) { acoes.push(`G-Care cliente ${idCliente}: ERRO ${e.message}`); }
    }
  }

  // 5) Teste_TI (preservado do PHP — template vazio, util p/ validar o fluxo)
  if (pipeId === PIPE_TESTE && faseId === '341856918' && (action === 'card.move' || action === 'card.create')) {
    for (const idCliente of arrayCampo(card, 'cliente')) {
      try {
        const cli = await dadosDatabasePorId(idCliente);
        const fone = fonePHP(valorRecord(cli.record_fields, 'telefone'));
        const params = [valorRecord(cli.record_fields, 'nome_fantasia'), cardId, await publicFormLink(cardId)];
        if (await enfileirar(Pg, { fone, cardId, faseId, action, templateId: '', parametros: params })) acoes.push(`Teste_TI ${fone}`);
      } catch (e) { acoes.push(`Teste_TI: ERRO ${e.message}`); }
    }
  }

  // 6) G-CARE NOVO (306859922) — WhatsApp ao CLIENTE/ATA espelhando os e-mails
  // de fase. Fases via create/move; agenda e troca de tecnico via field_update.
  if (pipeId === PIPE_GCARE_NOVO) {
    let cfg = null, gatilho = '';
    if (action === 'card.create') { cfg = GCARE_CREATE; gatilho = 'create'; }
    else if (action === 'card.move' && GCARE_MOVE[faseId]) { cfg = GCARE_MOVE[faseId]; gatilho = `move→${faseId}`; }
    else if (action === 'card.field_update') { cfg = GCARE_FIELD_TRIGGERS[trim(d.field?.id)]; gatilho = `field ${trim(d.field?.id)}`; }

    if (cfg) {
      const tplId = TPL_GCARE[cfg.tpl];
      if (!tplId) {
        acoes.push(`G-Care(novo) ${cfg.tpl}: template Suri não configurado (SURI_TPL_GCARE_${cfg.tpl.toUpperCase()}) — pulado`);
      } else {
        try {
          const ctx = await gcareContexto(card);
          const fone = fonePHP(cfg.destino === 'ata' ? ctx.ataFone : ctx.cliFone);
          const params = await cfg.params(ctx, cardId);
          if (await enfileirar(Pg, { fone, cardId, faseId, action, templateId: tplId, parametros: params }))
            acoes.push(`G-Care(novo) ${cfg.tpl} [${gatilho}] → ${cfg.destino} ${fone}`);
          else acoes.push(`G-Care(novo) ${cfg.tpl}: sem telefone válido (${cfg.destino}) ou duplicado`);
        } catch (e) { acoes.push(`G-Care(novo) ${cfg.tpl}: ERRO ${e.message}`); }
      }
    }
  }

  // envia o que entrou na fila (e eventuais pendencias antigas)
  const fila = await processarFila(Pg);
  return { acoes, fila };
}

module.exports = { processarEvento, processarFila, disponivel: () => !!TOKEN() };

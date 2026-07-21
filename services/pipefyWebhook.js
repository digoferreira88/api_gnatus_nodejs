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

// G-CARE INTERNO (307050389): fases que notificam o CLIENTE (template + builder).
// IDs configuraveis por env (SURI_TPL_GCI_*) — troca de template sem deploy.
// APROVACAO DO ORCAMENTO recriado 17/07/2026 (o anterior 1274682047953977 foi
// removido na Suri e retornava "Template not found" p/ todos os cards).
const FASES_CLIENTES_GCARE = {
  '342679685': { templateId: process.env.SURI_TPL_GCI_ENTRADA   || '1289814069144901', builder: buildEntradaFiscalParams },  // ENTRADA FISCAL
  '342527982': { templateId: process.env.SURI_TPL_GCI_ORCAMENTO || '3061938047335732', builder: buildOrcamentoParams },      // APROVACAO DO ORCAMENTO
  '342564106': { templateId: process.env.SURI_TPL_GCI_PAGAMENTO || '1462330982253878', builder: buildPagamentoParams },      // AGUARDANDO PAGAMENTO
  '342527971': { templateId: process.env.SURI_TPL_GCI_CONCLUIDO || '2059375837972044', builder: buildConcluidoParams }       // CONCLUIDO
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

// IDs dos templates aprovados no Suri/Meta (13/07/2026). Fixos aqui (mesmo
// padrao dos templates do G-Care interno acima); env sobrepoe se precisar trocar.
const TPL_GCARE = {
  protocolo:       process.env.SURI_TPL_GCARE_PROTOCOLO       || '1590706475821174',   // card criado -> cliente (7 params)
  orcamento:       process.env.SURI_TPL_GCARE_ORCAMENTO       || '1345407020429145',   // aprovacao do orcamento -> cliente
  validacao:       process.env.SURI_TPL_GCARE_VALIDACAO       || '2936016356749696',   // validacao/avaliacao -> cliente
  concluido:       process.env.SURI_TPL_GCARE_CONCLUIDO       || '1302368038546457',   // concluido -> cliente
  agendamento:     process.env.SURI_TPL_GCARE_AGENDAMENTO     || '1074055651620488',   // mudanca de agenda -> cliente
  troca_tecnico:   process.env.SURI_TPL_GCARE_TROCA_TECNICO   || '1562710422221068',   // troca de tecnico -> cliente (id anterior reprovado)
  solic_pagamento: process.env.SURI_TPL_GCARE_SOLIC_PAGAMENTO || '2217584992372328',   // solicitacao pagamento -> ATA
  os_reprovada:    process.env.SURI_TPL_GCARE_OS_REPROVADA    || '1529347948923999',   // OS reprovada pelo cliente -> ATA (id anterior reprovado)

  // --- 20/07/2026: os e-mails do pipe mudaram (11 -> 14 automacoes) e surgiu um
  // terceiro destinatario (TECNICO). Estes 6 sao NOVOS e estao AGUARDANDO
  // APROVACAO no Meta; ficam vazios de proposito para nao disparar "template not
  // found" (mesmo erro do 1274682047953977 no G-Care interno). Para ativar basta
  // preencher o .env e `pm2 reload api --update-env` — sem deploy. IDs enviados
  // p/ aprovacao: ata_abertura=1717236192653883 · ata_orc_aprovado=1518329723373514
  // · ata_orc_reprovado=1763569718327145 · tec_abertura=902157338995565
  // · tec_agendamento=2063063027930407 · tec_troca=2080431819522006
  ata_abertura:      process.env.SURI_TPL_GCARE_ATA_ABERTURA      || '',   // card criado -> ATA
  ata_orc_aprovado:  process.env.SURI_TPL_GCARE_ATA_ORC_APROVADO  || '',   // orcamento aprovado -> ATA
  ata_orc_reprovado: process.env.SURI_TPL_GCARE_ATA_ORC_REPROVADO || '',   // orcamento reprovado -> ATA
  tec_abertura:      process.env.SURI_TPL_GCARE_TEC_ABERTURA      || '',   // card criado -> TECNICO
  tec_agendamento:   process.env.SURI_TPL_GCARE_TEC_AGENDAMENTO   || '',   // mudanca de agenda -> TECNICO
  tec_troca:         process.env.SURI_TPL_GCARE_TEC_TROCA         || ''    // designado como novo tecnico -> TECNICO
};

// Versao 2 de templates que JA existem e cujo E-MAIL DE ORIGEM mudou em 20/07/2026:
// o texto novo tem parametros a mais, entao trocar so o ID quebraria o envio. Enquanto
// o env estiver vazio segue valendo o v1 (aprovado e em uso) com os params antigos;
// ao preencher, o dispatcher passa a usar o ID novo E o builder `paramsV2`.
const TPL_GCARE_V2 = {
  protocolo: process.env.SURI_TPL_GCARE_PROTOCOLO_V2 || '',   // aguardando aprovacao: 1543913217109780 (ganhou endereco + assinatura)
  validacao: process.env.SURI_TPL_GCARE_VALIDACAO_V2 || ''    // aguardando aprovacao: 1710997960124908 (novo texto do aviso de 3 dias)
};

// card.create -> 3 avisos (cliente, ATA e tecnico), espelhando os e-mails
// 309367355, 309417840 e 309727285. No protocolo o nº da OS aparece 2x no texto
// — no WhatsApp/Meta cada ocorrencia exige uma variavel propria.
const GCARE_CREATE = [
  { tpl: 'protocolo', destino: 'cliente', v2: 'protocolo',
    params:   (c) => [c.cliNome, c.os, c.tipoServico, c.dataAgendada, c.tecNome, c.os, c.ataFone],
    paramsV2: (c) => [c.cliNome, c.os, c.tipoServico, c.dataAgendada, c.tecNome, c.endereco, c.os, c.ataFone, c.ataNome] },
  { tpl: 'ata_abertura', destino: 'ata',
    params: async (c, id) => [c.ataNome, c.os, c.cliNomeCompleto, c.dataAgendada, c.tecNome, c.endereco, await publicFormLink(id)] },
  { tpl: 'tec_abertura', destino: 'tecnico',
    params: async (c, id) => [c.tecNome, c.os, c.cliNomeCompleto, c.dataAgendada, c.endereco, await publicFormLink(id), c.ataFone, c.ataNome] }
];
// card.move -> fase de destino (id) -> config (ou lista de configs)
const GCARE_MOVE = {
  '341608830': { tpl: 'orcamento', destino: 'cliente',                  // APROVACAO DO ORCAMENTO
    params: async (c, id) => [c.cliNome, c.os, await publicFormLink(id), c.ataFone] },
  '341356572': { tpl: 'validacao', destino: 'cliente', v2: 'validacao', // VALIDACAO E APROVACAO DO CLIENTE
    params:   async (c, id) => [c.cliNome, c.os, c.tipoServico, await publicFormLink(id)],
    paramsV2: async (c, id) => [c.cliNome, c.tipoServico, c.os, await publicFormLink(id), c.ataNome] },
  '341351613': { tpl: 'concluido', destino: 'cliente',                  // CONCLUIDO
    params: (c) => [c.cliNome, c.os, c.ataFone, c.ataNome] },
  '341437387': { tpl: 'solic_pagamento', destino: 'ata',               // SOLICITACAO DE PAGAMENTO
    params: async (c, id) => [c.ataNome, c.os, await publicFormLink(id)] },
  '341753703': { tpl: 'os_reprovada', destino: 'ata',                  // ORDEM DE SERVICO REPROVADA PELO CLIENTE
    params: async (c, id) => [c.ataNome, c.os, c.tecNome, await publicFormLink(id)] }
};
// card.field_update -> por slug do campo alterado (nao ha move de fase)
const GCARE_FIELD_TRIGGERS = {
  'data_e_hora_agendada_para_o_servi_o': [
    { tpl: 'agendamento', destino: 'cliente',
      params: (c) => [c.cliNome, c.os, c.dataAgendada, c.ataFone, c.ataNome] },
    { tpl: 'tec_agendamento', destino: 'tecnico',
      params: async (c, id) => [c.tecNome, c.os, c.dataAgendada, c.cliNome, c.endereco, await publicFormLink(id), c.ataFone, c.ataNome] }
  ],
  't_cnico_respons_vel': [
    { tpl: 'troca_tecnico', destino: 'cliente',
      params: (c) => [c.cliNome, c.tipoServico, c.os, c.tecNome, c.ataFone, c.ataNome] },
    { tpl: 'tec_troca', destino: 'tecnico',
      params: async (c, id) => [c.tecNome, c.tipoServico, c.os, c.cliNome, c.dataAgendada, c.endereco, await publicFormLink(id), c.ataFone, c.ataNome] }
  ],
  // APROVACAO DO ORCAMENTO -> STATUS DO ORCAMENTO (APROVADO/REPROVADO). No Pipefy os
  // dois e-mails (309375275/309375279) disparam no campo DATA com condicao sobre este
  // status; aqui o gatilho e o proprio status, que resolve os dois casos numa so passada.
  'status_do_or_amento_1': [
    { tpl: 'ata_orc_aprovado', destino: 'ata', quando: (c) => c.statusOrcamento === 'APROVADO',
      params: async (c, id) => [c.ataNome, c.os, await publicFormLink(id)] },
    { tpl: 'ata_orc_reprovado', destino: 'ata', quando: (c) => c.statusOrcamento === 'REPROVADO',
      params: async (c, id) => [c.ataNome, c.os, await publicFormLink(id)] }
  ]
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
  // template 3061938047335732: {{1}} nome do cliente · {{2}} Nº da OS interna
  // (campo ordem_de_servi_o_n) · {{3}} link público do orçamento.
  return [valorRecord(clienteFields, 'nome_fantasia'), valorCampo(card, 'ordem_de_servi_o_n'), await publicFormLink(cardId)];
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
// Endereco em UMA linha: os e-mails usam 5 campos (logradouro/bairro/cidade/UF/CEP);
// no WhatsApp isso vira um unico parametro.
function montaEndereco(logr, bairro, cidade, uf, cep) {
  const municipio = [trim(cidade), trim(uf)].filter(Boolean).join('/');
  const base = [trim(logr), trim(bairro), municipio].filter(Boolean).join(' - ');
  const c = trim(cep);
  return c ? (base ? `${base} - CEP ${c}` : `CEP ${c}`) : base;
}

async function gcareContexto(card) {
  const os = trim(valorCampo(card, 'ordem_de_servi_o_n')) || trim(card.title);
  const tipoServico = trim(valorCampo(card, 'tipo_de_atendimento'));
  const dataAgendada = trim(valorCampo(card, 'data_e_hora_agendada_para_o_servi_o'));
  const statusOrcamento = trim(valorCampo(card, 'status_do_or_amento_1')).toUpperCase();

  // CLIENTE: fone direto do card (telefone_whatsapp); nome/fallback fone no conector
  let cliNome = '', cliNomeCompleto = '', cliFone = trim(valorCampo(card, 'telefone_whatsapp'));
  let endCadastrado = '';
  const cliIds = arrayCampo(card, 'cliente');
  if (cliIds.length) {
    try {
      const r = await dadosDatabasePorId(cliIds[0]);
      cliNomeCompleto = trim(valorRecord(r.record_fields, 'nome'));
      cliNome = trim(valorRecord(r.record_fields, 'nome_fantasia')) || cliNomeCompleto;
      if (!cliFone) cliFone = trim(valorRecord(r.record_fields, 'telefone'));
      endCadastrado = montaEndereco(
        valorRecord(r.record_fields, 'endere_o'), valorRecord(r.record_fields, 'bairro'),
        valorRecord(r.record_fields, 'cidade'), valorRecord(r.record_fields, 'estado'),
        valorRecord(r.record_fields, 'cep'));
    } catch (e) { /* segue com o que tem */ }
  }
  if (!cliNomeCompleto) cliNomeCompleto = cliNome;

  // Endereco do atendimento: o do cadastro quando "SERA NO ENDERECO CADASTRADO? = SIM",
  // senao o bloco alternativo digitado no proprio card.
  const endAlternativo = montaEndereco(
    valorCampo(card, 'endere_o_do_cliente'), valorCampo(card, 'bairro_do_cliente'),
    valorCampo(card, 'cidade_do_cliente'), valorCampo(card, 'estado_do_cliente'),
    valorCampo(card, 'cep_do_cliente'));
  const usaCadastro = trim(valorCampo(card, 'a_instala_o_manuten_o_visita_t_cnica_ser_no_mesmo_endere_o_cadastradado')).toUpperCase() !== 'NÃO';
  const endereco = (usaCadastro ? endCadastrado : endAlternativo) || endCadastrado || endAlternativo;

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

  // TECNICO responsavel (a tabela tem TELEFONE (WHATSAPP) = telefone_whatsapp)
  let tecNome = '', tecFone = '';
  const tecIds = arrayCampo(card, 't_cnico_respons_vel');
  if (tecIds.length) {
    try {
      const r = await dadosDatabasePorId(tecIds[0]);
      tecNome = trim(valorRecord(r.record_fields, 'nome_completo'));
      tecFone = trim(valorRecord(r.record_fields, 'telefone_whatsapp'));
    } catch (e) { /* segue */ }
  }

  return { os, tipoServico, dataAgendada, statusOrcamento, endereco,
    cliNome, cliNomeCompleto, cliFone, ataNome, ataFone, tecNome, tecFone };
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

  // 6) G-CARE NOVO (306859922) — WhatsApp ao CLIENTE/ATA/TECNICO espelhando os
  // e-mails de fase. Fases via create/move; agenda, troca de tecnico e status do
  // orcamento via field_update. Um mesmo evento pode gerar VARIOS envios (ex.:
  // card criado avisa cliente, ATA e tecnico), por isso a config e uma lista.
  if (pipeId === PIPE_GCARE_NOVO) {
    let cfgs = null, gatilho = '';
    if (action === 'card.create') { cfgs = GCARE_CREATE; gatilho = 'create'; }
    else if (action === 'card.move' && GCARE_MOVE[faseId]) { cfgs = GCARE_MOVE[faseId]; gatilho = `move→${faseId}`; }
    else if (action === 'card.field_update') { cfgs = GCARE_FIELD_TRIGGERS[trim(d.field?.id)]; gatilho = `field ${trim(d.field?.id)}`; }

    const lista = [].concat(cfgs || []);
    if (lista.length) {
      let ctx = null;
      for (const cfg of lista) {
        // v2 = versao nova do template (e-mail alterado); so entra quando o env esta
        // preenchido, senao segue o v1 aprovado com o builder antigo.
        const idV2 = cfg.v2 ? TPL_GCARE_V2[cfg.v2] : '';
        const tplId = idV2 || TPL_GCARE[cfg.tpl];
        const build = (idV2 && cfg.paramsV2) ? cfg.paramsV2 : cfg.params;
        if (!tplId) {
          acoes.push(`G-Care(novo) ${cfg.tpl}: template Suri não configurado (SURI_TPL_GCARE_${cfg.tpl.toUpperCase()}) — pulado`);
          continue;
        }
        try {
          if (!ctx) ctx = await gcareContexto(card);
          if (cfg.quando && !cfg.quando(ctx)) continue;   // ex.: orcamento aprovado x reprovado
          const fone = fonePHP(cfg.destino === 'ata' ? ctx.ataFone
            : cfg.destino === 'tecnico' ? ctx.tecFone : ctx.cliFone);
          const params = await build(ctx, cardId);
          // Dedupe por TELEFONE dentro do evento (chave = phone+card+fase+acao, SEM o
          // template): se cliente, ATA e tecnico forem o MESMO numero (mesma pessoa em
          // 2 papeis, ou teste com 1 numero), envia UMA vez so — a 1a config da lista
          // vence (cliente tem prioridade). Numeros distintos (caso normal de producao)
          // recebem cada um o seu template. Corrige o card 1417017461 (cliente=tecnico
          // no mesmo fone recebia protocolo E tec_abertura).
          if (await enfileirar(Pg, { fone, cardId, faseId, action, templateId: tplId, parametros: params }))
            acoes.push(`G-Care(novo) ${cfg.tpl} [${gatilho}] → ${cfg.destino} ${fone}`);
          else acoes.push(`G-Care(novo) ${cfg.tpl}: sem telefone válido (${cfg.destino}) ou já enviado a este número`);
        } catch (e) { acoes.push(`G-Care(novo) ${cfg.tpl}: ERRO ${e.message}`); }
      }
    }
  }

  // envia o que entrou na fila (e eventuais pendencias antigas)
  const fila = await processarFila(Pg);
  return { acoes, fila };
}

module.exports = { processarEvento, processarFila, disponivel: () => !!TOKEN() };

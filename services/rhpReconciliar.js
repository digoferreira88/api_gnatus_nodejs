// services/rhpReconciliar.js — reconcilia a falha recorrente do LINK do PDF no pipe
// RHP (Registro Histórico do Produto, 304059336).
//
// CAUSA RAIZ (diagnóstico 04/09/2026): o campo url_anexo_do_relat_rio_de_montagem é
// preenchido por um Zap EXTERNO (Marcelo de Souza) que, quando o card entra em
// "Impressão do Rótulo", procura o arquivo {OP}{série}.pdf na pasta OneDrive da
// pipefy@ (Documents/Pipefy compartilhada). Se o PDF NÃO está lá naquele instante,
// grava o texto "Erro no upload do arquivo..." e NÃO TENTA DE NOVO. Como a produção
// costuma subir o PDF DEPOIS de o card ser criado, o erro fica congelado pra sempre
// mesmo depois de o arquivo aparecer (corrida de tempo, sem retry).
//
// TRATAMENTO: este robô varre o pipe atrás dos cards com o texto de erro, e quando o
// PDF JÁ existe no OneDrive, grava o link correto (o mesmo /shared?... que os cards
// bons usam — SEM https://, porque o "Conteúdo dinâmico" do pipe concatena o https://;
// ver [[pipefy-rm-pdf-link-fix]]). Card cujo PDF genuinamente não existe fica logado
// como AUSENTE (a produção precisa gerar). NÃO substitui o Zap — só conserta o que
// ele deixou pra trás.
//
// Gates (.env):
//   RHP_RECON_ATIVO=1     liga o robô (default DESLIGADO)
//   RHP_RECON_SIMULAR=0   desliga o dry-run (default SIMULA: loga o que faria)
//   PIPEFY_TOKEN          + M365_TENANT_ID/CLIENT_ID/CLIENT_SECRET (Graph)

const trim = (v) => String(v == null ? '' : v).trim();

const PIPE_ID = '304059336';
const CAMPO_LINK = 'url_anexo_do_relat_rio_de_montagem';
const CAMPO_OP = 'n_mero_de_op_protheus';
const CAMPO_SERIE = 'n_meros_de_s_rie';
const RE_ERRO = /erro no upload|verifique se o registro/i;

// Pasta destino no OneDrive pessoal da pipefy@ (onde o Zap procura e onde a produção sobe).
const SITE_PATH = '/personal/pipefy_gnatus_com_br';
const PASTA = 'Pipefy compartilhada';

const TOKEN = () => trim(process.env.PIPEFY_TOKEN);
const ATIVO = () => trim(process.env.RHP_RECON_ATIVO) === '1';
const SIMULAR = () => trim(process.env.RHP_RECON_SIMULAR) !== '0';   // default: simula
const graphConfig = () => !!(process.env.M365_TENANT_ID && process.env.M365_CLIENT_ID && process.env.M365_CLIENT_SECRET);

const disponivel = () => ATIVO() && !!TOKEN() && graphConfig();

// ---------- Pipefy ----------
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
    if (!r.ok || j.errors) throw new Error(`Pipefy: ${j.errors ? j.errors.map(e => e.message).join('; ') : `HTTP ${r.status}`}`);
    return j.data;
  } catch (e) { clearTimeout(timer); throw e; }
}

const campo = (card, id) => trim((card.fields || []).find(f => f.field?.id === id)?.value);

// Todos os cards do pipe (todas as fases) que estão com o texto de ERRO no link.
async function listarCardsComErro() {
  const fases = (await gql(`query($id:ID!){pipe(id:$id){phases{id}}}`, { id: PIPE_ID })).pipe.phases;
  const out = [];
  for (const fase of fases) {
    let after = null;
    do {
      const d = await gql(`query($fid:ID!,$a:String){phase(id:$fid){cards(first:50,after:$a){
        pageInfo{hasNextPage endCursor} edges{node{id title fields{value field{id}}}}}}}`, { fid: fase.id, a: after });
      const pg = d.phase?.cards;
      (pg?.edges || []).forEach(e => {
        if (RE_ERRO.test(campo(e.node, CAMPO_LINK))) out.push(e.node);
      });
      after = pg?.pageInfo?.hasNextPage ? pg.pageInfo.endCursor : null;
    } while (after);
  }
  return out;
}

// Grava o link no campo. new_value é escalar UndefinedInput -> vai INLINE (variável
// String! dá "Type mismatch"; ver [[pipefy-rm-pdf-link-fix]]).
async function gravarLink(cardId, valor) {
  await gql(`mutation{ updateCardField(input:{ card_id:${cardId}, field_id:"${CAMPO_LINK}", new_value:${JSON.stringify(valor)} }){ success } }`);
}

// ---------- Graph (OneDrive pessoal da pipefy@) ----------
let _driveId = null;
async function graphToken() {
  const b = new URLSearchParams({
    client_id: process.env.M365_CLIENT_ID, client_secret: process.env.M365_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials'
  });
  const r = await fetch(`https://login.microsoftonline.com/${process.env.M365_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Graph token: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}
async function graphGet(tok, path) {
  const r = await fetch(`https://graph.microsoft.com/v1.0${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
}
async function driveId(tok) {
  if (_driveId) return _driveId;
  const site = await graphGet(tok, `/sites/gnatus-my.sharepoint.com:${SITE_PATH}`);
  if (!site.json?.id) throw new Error('Graph site pipefy@ não resolveu: ' + JSON.stringify(site.json).slice(0, 200));
  const drv = await graphGet(tok, `/sites/${site.json.id}/drive`);
  if (!drv.json?.id) throw new Error('Graph drive não resolveu');
  _driveId = drv.json.id;
  return _driveId;
}
// Conjunto de nomes de arquivo na pasta (1 fetch, paginando).
async function listarArquivos(tok) {
  const did = await driveId(tok);
  const set = new Set();
  let url = `/drives/${did}/root:/${encodeURIComponent(PASTA)}:/children?$select=name&$top=999`;
  while (url) {
    const r = await graphGet(tok, url);
    if (!r.ok) throw new Error('Graph list children: HTTP ' + r.status);
    (r.json.value || []).forEach(x => set.add(String(x.name)));
    url = r.json['@odata.nextLink'] ? r.json['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '') : null;
  }
  return set;
}

// ---------- Regras de nome / link ----------
// Nome do arquivo = {OP}{série}. OP = 11 díg; série = 10 díg (zero-pad se numérica e curta).
function nomeArquivo(op, serie) {
  const o = trim(op).replace(/\D/g, '');
  let s = trim(serie);
  if (/^\d+$/.test(s) && s.length < 10) s = s.padStart(10, '0');
  return { arq: `${o}${s}`, op: o, serie: s };
}

// Link EXATO no formato dos cards bons (SEM https://). Só a parte do nome muda.
const P = '%2Fpersonal%2Fpipefy%5Fgnatus%5Fcom%5Fbr%2FDocuments%2FPipefy%20compartilhada';
const linkValor = (arq) =>
  'gnatus-my.sharepoint.com/shared?listurl=https%3A%2F%2Fgnatus%2Dmy%2Esharepoint%2Ecom%2Fpersonal%2Fpipefy%5Fgnatus%5Fcom%5Fbr%2FDocuments' +
  `&id=${P}%2F${arq}%2Epdf&parent=${P}`;

// ---------- Execução ----------
async function executar(app, origem = 'CRON') {
  const { Pg } = app.services ? app.services : app;
  const resumo = { cards: 0, corrigidos: 0, simulados: 0, ausentes: 0, erros: 0, detalhes: [] };
  const logar = async (card, r) => {
    try {
      await Pg.connectAndQuery(`
        INSERT INTO tab_rhp_reconciliacao_log (card_id, op, serie, arquivo, resultado, detalhe, origem)
        VALUES (@id, @op, @serie, @arq, @res, @det, @origem)`,
        { id: trim(card.id), op: r.op || null, serie: r.serie || null, arq: r.arq || null,
          res: r.resultado, det: (r.detalhe || '').slice(0, 1000), origem });
    } catch (e) { console.error('[rhp-recon] log falhou:', e.message); }
  };

  if (!disponivel()) return { ...resumo, inativo: true };

  const cards = await listarCardsComErro();
  resumo.cards = cards.length;
  if (!cards.length) return resumo;

  const tok = await graphToken();
  const arquivos = await listarArquivos(tok);

  for (const card of cards) {
    const op = campo(card, CAMPO_OP) || trim(card.title);
    const serie = campo(card, CAMPO_SERIE);
    if (!op || !serie) { resumo.ausentes++; await logar(card, { op, serie, resultado: 'SEM_OP_SERIE', detalhe: 'card sem OP/série' }); continue; }

    const { arq } = nomeArquivo(op, serie);
    const nomePdf = `${arq}.pdf`;
    if (!arquivos.has(nomePdf)) {
      resumo.ausentes++;
      await logar(card, { op, serie, arq, resultado: 'AUSENTE', detalhe: `PDF "${nomePdf}" ainda não está na pasta (produção não gerou/subiu)` });
      continue;
    }

    const valor = linkValor(arq);
    if (SIMULAR()) {
      resumo.simulados++;
      await logar(card, { op, serie, arq, resultado: 'SIMULADO', detalhe: `SIMULAÇÃO — gravaria o link de "${nomePdf}"` });
      continue;
    }
    try {
      await gravarLink(card.id, valor);
      resumo.corrigidos++;
      await logar(card, { op, serie, arq, resultado: 'CORRIGIDO', detalhe: `link de "${nomePdf}" gravado` });
      try {
        const Auditoria = require('./auditoria');
        Auditoria.registrar({ services: { Pg } }, {
          modulo: 'Produção', submodulo: 'RHP', acao: 'LINK_PDF_RECONCILIADO', severidade: 'INFO',
          entidade: 'pipefy_card', entidadeId: trim(card.id),
          descricao: `RHP: link do PDF ${nomePdf} reconciliado no card "${trim(card.title)}" (${origem})`
        });
      } catch (e) { console.warn('[rhp-recon] auditoria:', e.message); }
    } catch (e) {
      resumo.erros++;
      await logar(card, { op, serie, arq, resultado: 'ERRO', detalhe: 'Pipefy: ' + e.message });
    }
  }
  return resumo;
}

module.exports = { disponivel, executar, PIPE_ID, CAMPO_LINK };

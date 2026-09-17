// services/kanbanPedidos.js — Kanban de Gestão de Pedidos (Pós-Venda / CS), Fase 1.
//
// Tudo é LEITURA. Em que etapa o pedido está e desde quando saem do Protheus;
// a entrega sai da Datafrete (cache em tab_nf_entrega). Análise completa no
// documento "Kanban de Gestão de Pedidos — viabilidade e proposta" (17/09/2026).
//
// ETAPAS (na ordem do fluxo real):
//   comercial    estatus 10  aguardando liberação do comercial
//   financeiro   estatus 20/25 (e C9_BLCRED '04', que a view não mapeia)
//   planejamento estatus 30
//   formulacao   estatus 40  formulação financeira (blcred 90)
//   estoque      estatus 50
//   faturamento  estatus 60
//   expedicao    todos os itens faturados, alguma NF física sem expedição
//   transporte   tudo expedido, alguma NF física sem entrega confirmada
//   entregue     todas as NFs físicas entregues (ou nenhuma NF física)
//
// ENTRADA NA ETAPA = a liberação mais recente que o pedido já recebeu. O Protheus
// grava data+hora de cada liberação no SC5 (medido em 17/09 nos pedidos de 2026):
//   C5_DT1LIBE/HR1LIBE  1ª liberação (sai do comercial)         93%
//   C5_DTLIBFI/HRLIBFI  liberação financeira                     64% (resto: sem bloqueio)
//   C5_DTLIBPL/HRLIBPL  liberação de planejamento                91%
//   C5_DTLIBRI/HRLIBRI  liberação da FORMULAÇÃO financeira       62% (validado: dos 22
//                       pedidos parados na etapa 40, só 1 tem RI; RI vem depois do
//                       planejamento em 4.520 × 174 e nunca existe sem financeiro)
//   C5_DTLIBES/HRLIBES  liberação de estoque                     71%
// Como financeiro e formulação são opcionais, "a mais recente disponível" cobre os
// pedidos que pularam etapa. O Protheus guarda só a ÚLTIMA ocorrência de cada
// liberação: se o pedido foi estornado e voltou, a entrada é ESTIMADA (flag).
//
// VENDA PARA ENTREGA FUTURA (consultórios, principalmente): a venda sai com NF de
// simples faturamento (CFOP 5922/6922), que não tem remessa física; o produto sai
// depois, num OUTRO pedido, com NF de remessa (5116/5117/6116/6117). O Protheus não
// liga os dois pedidos em campo próprio. A ligação usada aqui (medida em 17/09, 2026):
//   1. mensagem da nota do pedido de remessa (C5_MENNOTA) "REMESSA DE ENTREGA
//      REFERENTE A NF 091654 DE 08/09/2026" -> 81 das 135 remessas; 80 resolvem
//      para uma venda do mesmo cliente;
//   2. sem mensagem: mesmo cliente e loja, remessa depois da venda, e o cliente tem
//      uma única venda para entrega futura carregada -> vínculo "provável".
// A venda segue as NFs da remessa até a entrega; sem remessa, fica "aguardando
// remessa" em Faturado (sem semáforo: a remessa depende do cliente, p50 7 dias,
// p90 34). O pedido de remessa ligado some do painel para não contar em dobro.

const Datafrete = require('./datafreteTms');

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);
const HORA = 3600e3;
const normalizar = (s) => trim(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

const ETAPAS = [
  { codigo: 'comercial',    nome: 'Liberação comercial' },
  { codigo: 'financeiro',   nome: 'Análise financeira' },
  { codigo: 'planejamento', nome: 'Liberação de planejamento' },
  { codigo: 'formulacao',   nome: 'Formulação financeira' },
  { codigo: 'estoque',      nome: 'Liberação de estoque' },
  { codigo: 'faturamento',  nome: 'Aguardando faturamento' },
  { codigo: 'expedicao',    nome: 'Faturado, aguardando expedição' },
  { codigo: 'transporte',   nome: 'Em transporte' },
  { codigo: 'entregue',     nome: 'Entregue' }
];
const ORDEM = Object.fromEntries(ETAPAS.map((e, i) => [e.codigo, i]));
const ETAPA_POR_ESTATUS = { 10: 'comercial', 20: 'financeiro', 25: 'financeiro', 30: 'planejamento', 40: 'formulacao', 50: 'estoque', 60: 'faturamento' };

// Mesma lista do módulo de Expedição: NF só com estes CFOPs não gera remessa física
// (venda à ordem, simples faturamento, remessas de depósito) e nunca é expedida.
const CFOPS_SEM_REMESSA = ['5118', '6118', '5119', '6119', '5934', '5905', '5922', '6922'];
const CFOPS_ENTREGA_FUTURA = ['5922', '6922'];
const CFOPS_REMESSA_FUTURA = ['5116', '5117', '6116', '6117'];
const listaSql = (l) => l.map(c => `'${c}'`).join(',');

// "REMESSA DE ENTREGA REFERENTE A NF 091654 DE 08/09/2026"
const RE_NF_REFERENCIA = /NF\.?\s*(?:N[º°O]?\.?\s*)?:?\s*(\d{4,9})/gi;

// Transportadoras que a Datafrete praticamente nunca confirma como entregue (medido
// em 17/09: frota própria/retirada 11%, Mercado Livre 0%). A nota fica "em transporte"
// até a baixa manual da Fase 2; o card é marcado e vai para o fim da coluna, para não
// esconder os atrasos reais das transportadoras rastreadas.
const TRANSP_SEM_RASTREIO = /^(GNATUS|EBAZAR)/i;

// BUs que não são pedido a acompanhar: remessa simbólica (CFOP 5934) é só fiscal.
const BUS_FORA_DO_PAINEL = new Set(['RETORNO SIMBOLICO']);

// ---------------------------------------------------------------------------
// Datas. Todos os instantes trafegam como epoch "ingênuo" em horário de Brasília
// (Date.UTC sobre os campos locais), e saem como 'YYYY-MM-DDTHH:MM' sem fuso —
// assim o relógio da VPS (que pode estar em UTC) não desloca nada.
// ---------------------------------------------------------------------------
const tsProtheus = (data, hora) => {
  const d = trim(data);
  if (!/^\d{8}$/.test(d)) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(trim(hora));
  return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), m ? +m[1] : 0, m ? +m[2] : 0, m && m[3] ? +m[3] : 0);
};

const agoraBrasilia = () => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
};

const fmtTs = (ts) => {
  if (ts == null) return null;
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};
const fmtData = (data) => (/^\d{8}$/.test(trim(data)) ? `${trim(data).slice(0, 4)}-${trim(data).slice(4, 6)}-${trim(data).slice(6, 8)}` : null);
const protheusData = (ts) => fmtTs(ts).slice(0, 10).replace(/-/g, '');
const maxTs = (lista) => { const v = lista.filter(t => t != null && isFinite(t)); return v.length ? Math.max(...v) : null; };

// I_N_S_D_T_ (momento em que o registro nasceu no banco) é gravado em UTC; o
// driver devolve como Date. Horário de Brasília = UTC - 3h (sem horário de verão).
const insParaBrasilia = (ins) => (ins ? new Date(ins).getTime() - 3 * HORA : null);

// dt_evento da Datafrete vem como 'YYYY-MM-DD HH:MM:SS' local.
const tsDatafrete = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(trim(s));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
};

// dt_evento do Postgres (timestamp sem fuso) volta do driver como Date "local da VPS".
// Reconstrói o epoch ingênuo pelos campos, independente do fuso do servidor.
const tsPg = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
};

// ---------------------------------------------------------------------------
// Configuração (SLA + parâmetros)
// ---------------------------------------------------------------------------
async function carregarConfig(app) {
  const { Pg } = app.services;
  const [slaRows, cfgRows] = await Promise.all([
    Pg.connectAndQuery(`SELECT etapa, nome, ordem, sla_horas, atualizado_em FROM tab_kanban_pedido_sla ORDER BY ordem`, {}),
    Pg.connectAndQuery(`SELECT chave, valor FROM tab_kanban_pedido_config`, {})
  ]);
  const sla = {};
  slaRows.forEach(r => { sla[trim(r.etapa)] = N(r.sla_horas); });
  const cfg = Object.fromEntries(cfgRows.map(r => [trim(r.chave), trim(r.valor)]));
  return {
    sla,
    slaLista: slaRows.map(r => ({ etapa: trim(r.etapa), nome: trim(r.nome), ordem: N(r.ordem), slaHoras: N(r.sla_horas), atualizadoEm: r.atualizado_em })),
    curvaAValor: N(cfg.curva_a_valor) || 60000,
    periodoPadraoDias: N(cfg.periodo_padrao_dias) || 90,
    amareloPct: N(cfg.amarelo_pct) || 80
  };
}

// ---------------------------------------------------------------------------
// Sincronização das entregas (scheduler a cada 30 min; carga inicial via script)
// ---------------------------------------------------------------------------
async function sincronizarEntregas(app, { dias = 7, inicio = null, fim = null } = {}) {
  const { Pg } = app.services;
  if (!Datafrete.disponivel()) return { ok: false, motivo: 'DATAFRETE_SERVICES_KEY ausente' };

  await Pg.connectAndQuery(`UPDATE tab_nf_entrega_sync SET ultima_tentativa = NOW() WHERE id = 1`, {});
  const r = inicio
    ? await Datafrete.consultarOcorrenciasPeriodo({ inicio, fim: fim || new Date() })
    : await Datafrete.consultarOcorrencias({ dias });
  if (!r.ok) {
    const erro = `HTTP ${r.http} ${trim(r.txt).slice(0, 200)}`;
    await Pg.connectAndQuery(`UPDATE tab_nf_entrega_sync SET ultimo_erro = @erro WHERE id = 1`, { erro });
    return { ok: false, motivo: erro };
  }

  // A consulta devolve os blocos do mais novo para o mais antigo, e extrairEntregas
  // fica com o PRIMEIRO evento de entrega que encontra. Ordenando por data, a
  // entrega gravada é a primeira confirmação, e o "último evento" é de fato o último.
  const eventos = [...r.eventos].sort((a, b) => String(a.dt_evento || '').localeCompare(String(b.dt_evento || '')));
  const nfs = Datafrete.extrairEntregas(eventos).filter(e => /^\d{44}$/.test(trim(e.chaveNf)));
  let gravadas = 0;
  for (const e of nfs) {
    const dt = tsDatafrete(e.dtEvento);
    // Entregue nunca "desentrega": um evento posterior (ex.: comprovante) não
    // derruba a entrega já registrada, nem troca a data dela.
    await Pg.connectAndQuery(`
      INSERT INTO tab_nf_entrega (chave_nf, numero_nf, serie_nf, entregue, dt_evento, descricao, atualizado_em)
      VALUES (@chave, @num, @serie, @entregue, @dt::timestamp, @desc, NOW())
      ON CONFLICT (chave_nf) DO UPDATE SET
        entregue      = tab_nf_entrega.entregue OR EXCLUDED.entregue,
        dt_evento     = CASE WHEN tab_nf_entrega.entregue THEN tab_nf_entrega.dt_evento ELSE EXCLUDED.dt_evento END,
        descricao     = CASE WHEN tab_nf_entrega.entregue THEN tab_nf_entrega.descricao ELSE EXCLUDED.descricao END,
        atualizado_em = NOW()`,
      {
        chave: trim(e.chaveNf), num: trim(e.numeroNf).slice(0, 20), serie: trim(e.serieNf).slice(0, 5),
        entregue: !!e.entregue, dt: dt != null ? fmtTs(dt).replace('T', ' ') : null,
        desc: trim(e.descricao).slice(0, 300)
      });
    gravadas++;
  }
  await Pg.connectAndQuery(
    `UPDATE tab_nf_entrega_sync SET ultima_ok = NOW(), ultimo_erro = NULL, nfs_na_ultima = @n WHERE id = 1`, { n: gravadas });
  return { ok: true, eventos: r.eventos.length, nfs: gravadas, entregues: nfs.filter(e => e.entregue).length };
}

// ---------------------------------------------------------------------------
// Leitura do Protheus. `escopo`:
//   { ini, fim }            emissão YYYYMMDD (lista do painel)
//   { num }                 um pedido
//   { cli, loja, desde }    pedidos do cliente desde a data, só os de entrega futura
//                           (venda ou remessa) — vínculo no detalhe
//   { remessaNfDesde, foraIni, foraFim, emissaoMin }
//                           pedidos de remessa FORA do período cuja NF de remessa saiu
//                           a partir da data. O pedido de remessa às vezes é criado
//                           antes da venda (ex.: 093108 -> venda 095043) ou depois do fim.
// ---------------------------------------------------------------------------
async function lerProtheus(app, escopo) {
  const { Protheus } = app.services;
  const cfopsEf = listaSql(CFOPS_ENTREGA_FUTURA);
  const cfopsRem = listaSql(CFOPS_REMESSA_FUTURA);
  const temNf = (cfopsLista, extra = '') => `EXISTS (SELECT 1 FROM SD2010 xd WITH (NOLOCK) WHERE xd.D_E_L_E_T_ <> '*'
      AND xd.D2_FILIAL = c5.C5_FILIAL AND xd.D2_PEDIDO = c5.C5_NUM AND xd.D2_CF IN (${cfopsLista})${extra})`;
  const params = {};
  let filtroC5;
  if (escopo.num) {
    params.num = trim(escopo.num);
    filtroC5 = `c5.C5_NUM = @num`;
  } else if (escopo.cli) {
    params.cli = trim(escopo.cli); params.loja = trim(escopo.loja); params.desde = escopo.desde;
    filtroC5 = `c5.C5_CLIENTE = @cli AND c5.C5_LOJACLI = @loja AND c5.C5_EMISSAO >= @desde AND ${temNf(`${cfopsEf},${cfopsRem}`)}`;
  } else if (escopo.remessaNfDesde) {
    Object.assign(params, { rdesde: escopo.remessaNfDesde, xini: escopo.foraIni, xfim: escopo.foraFim, emin: escopo.emissaoMin });
    filtroC5 = `c5.C5_EMISSAO >= @emin AND (c5.C5_EMISSAO < @xini OR c5.C5_EMISSAO > @xfim)
      AND ${temNf(cfopsRem, ' AND xd.D2_EMISSAO >= @rdesde')}`;
  } else {
    params.ini = escopo.ini; params.fim = escopo.fim;
    filtroC5 = `c5.C5_EMISSAO BETWEEN @ini AND @fim`;
  }
  // Só pedido NORMAL: devolução, beneficiamento e complemento não são venda a acompanhar.
  const baseC5 = `c5.D_E_L_E_T_ <> '*' AND c5.C5_FILIAL = '01' AND c5.C5_TIPO = 'N' AND ${filtroC5}`;
  const cfops = listaSql(CFOPS_SEM_REMESSA);

  const [cab, itens, nfs, qtd] = await Promise.all([
    Protheus.connectAndQuery(`
      SELECT RTRIM(c5.C5_NUM) num, c5.C5_EMISSAO emissao, c5.I_N_S_D_T_ ins,
             RTRIM(c5.C5_CLIENTE) cli, RTRIM(c5.C5_LOJACLI) loja, RTRIM(sa1.A1_NOME) cliNome, RTRIM(sa1.A1_EST) uf,
             RTRIM(c5.C5_VEND1) vend, RTRIM(sa3.A3_NOME) vendNome,
             RTRIM(c5.C5_ZTIPO) buCod, RTRIM(bu.X5_DESCRI) buNome,
             RTRIM(CAST(c5.C5_MENNOTA AS VARCHAR(300))) mennota,
             c5.C5_DT1LIBE d1, c5.C5_HR1LIBE h1, RTRIM(c5.C5_USU1LIB) u1,
             c5.C5_DTLIBFI dfi, c5.C5_HRLIBFI hfi,
             c5.C5_DTLIBPL dpl, c5.C5_HRLIBPL hpl,
             c5.C5_DTLIBRI dri, c5.C5_HRLIBRI hri,
             c5.C5_DTLIBES des, c5.C5_HRLIBES hes
        FROM SC5010 c5 WITH (NOLOCK)
        LEFT JOIN SA1010 sa1 WITH (NOLOCK) ON sa1.A1_COD = c5.C5_CLIENTE AND sa1.A1_LOJA = c5.C5_LOJACLI AND sa1.D_E_L_E_T_ <> '*'
        LEFT JOIN SA3010 sa3 WITH (NOLOCK) ON sa3.A3_COD = c5.C5_VEND1 AND sa3.D_E_L_E_T_ <> '*'
        LEFT JOIN SX5010 bu WITH (NOLOCK) ON bu.X5_FILIAL = '  ' AND bu.X5_TABELA = 'Z1'
             AND RTRIM(bu.X5_CHAVE) = RTRIM(c5.C5_ZTIPO) AND bu.D_E_L_E_T_ <> '*'
       WHERE ${baseC5}`, params),

    // Itens com o estágio da view pedidos_estatus (a mesma fonte do resto da intranet).
    Protheus.connectAndQuery(`
      SELECT RTRIM(pe.c6_num) num, RTRIM(pe.c6_item) item, pe.estatus_cod cod,
             RTRIM(ISNULL(pe.c9_blcred, '')) blcred,
             RTRIM(c6.C6_PRODUTO) produto, RTRIM(c6.C6_DESCRI) descricao,
             c6.C6_QTDVEN qtdVen, c6.C6_QTDENT qtdEnt, c6.C6_VALOR valor,
             RTRIM(c6.C6_BLQ) blq, c6.C6_ENTREG entreg
        FROM pedidos_estatus pe
        JOIN SC6010 c6 WITH (NOLOCK) ON c6.C6_FILIAL = pe.c6_filial AND c6.C6_NUM = pe.c6_num
             AND c6.C6_ITEM = pe.c6_item AND c6.C6_PRODUTO = pe.c6_produto AND c6.D_E_L_E_T_ <> '*'
        JOIN SC5010 c5 WITH (NOLOCK) ON c5.C5_FILIAL = pe.c6_filial AND c5.C5_NUM = pe.c6_num
       WHERE pe.c6_filial = '01' AND ${baseC5}`, params),

    // NFs de cada pedido. "fisica" = série 1 com algum CFOP que gera remessa — a mesma
    // regra que decide se a nota aparece na tela de Expedição. "ef"/"rem" marcam a NF
    // de venda e a de remessa da entrega futura.
    Protheus.connectAndQuery(`
      SELECT RTRIM(d2.D2_PEDIDO) num, RTRIM(f2.F2_DOC) doc, RTRIM(f2.F2_SERIE) serie,
             f2.F2_EMISSAO emissao, RTRIM(f2.F2_HORA) hora, RTRIM(f2.F2_CHVNFE) chave,
             RTRIM(sa4.A4_NOME) transp, fe.z1_expedic expedicao, RTRIM(ISNULL(fe.z1_rastrei, '')) rastreio,
             MAX(CASE WHEN d2.D2_CF IN (${cfopsEf}) THEN 1 ELSE 0 END) ef,
             MAX(CASE WHEN d2.D2_CF IN (${cfopsRem}) THEN 1 ELSE 0 END) rem,
             CASE WHEN f2.F2_SERIE = '1' AND EXISTS (
                    SELECT 1 FROM faturamento_cfop fc
                     WHERE fc.d2_filial = f2.F2_FILIAL AND fc.d2_doc = f2.F2_DOC AND fc.d2_serie = f2.F2_SERIE
                       AND fc.d2_cf NOT IN (${cfops}))
                  THEN 1 ELSE 0 END fisica
        FROM SD2010 d2 WITH (NOLOCK)
        JOIN SC5010 c5 WITH (NOLOCK) ON c5.C5_FILIAL = d2.D2_FILIAL AND c5.C5_NUM = d2.D2_PEDIDO
        JOIN SF2010 f2 WITH (NOLOCK) ON f2.F2_FILIAL = d2.D2_FILIAL AND f2.F2_DOC = d2.D2_DOC
             AND f2.F2_SERIE = d2.D2_SERIE AND f2.F2_CLIENTE = d2.D2_CLIENTE AND f2.F2_LOJA = d2.D2_LOJA
             AND f2.D_E_L_E_T_ <> '*'
        LEFT JOIN faturamento_expedicao fe ON fe.z1_filial = f2.F2_FILIAL AND fe.z1_doc = f2.F2_DOC AND fe.z1_serie = f2.F2_SERIE
        LEFT JOIN SA4010 sa4 WITH (NOLOCK) ON sa4.A4_COD = f2.F2_TRANSP AND sa4.D_E_L_E_T_ <> '*'
       WHERE d2.D_E_L_E_T_ <> '*' AND d2.D2_FILIAL = '01' AND ${baseC5}
       GROUP BY d2.D2_PEDIDO, f2.F2_FILIAL, f2.F2_DOC, f2.F2_SERIE, f2.F2_EMISSAO, f2.F2_HORA, f2.F2_CHVNFE,
                sa4.A4_NOME, fe.z1_expedic, fe.z1_rastrei`, params),

    // Quantidade por produto nas NFs de venda e de remessa da entrega futura, para
    // saber se a remessa já cobriu tudo o que foi vendido.
    Protheus.connectAndQuery(`
      SELECT RTRIM(d2.D2_PEDIDO) num, RTRIM(d2.D2_COD) produto,
             CASE WHEN d2.D2_CF IN (${cfopsEf}) THEN 'ef' ELSE 'rem' END tipo, SUM(d2.D2_QUANT) qtd
        FROM SD2010 d2 WITH (NOLOCK)
        JOIN SC5010 c5 WITH (NOLOCK) ON c5.C5_FILIAL = d2.D2_FILIAL AND c5.C5_NUM = d2.D2_PEDIDO
       WHERE d2.D_E_L_E_T_ <> '*' AND d2.D2_FILIAL = '01' AND d2.D2_CF IN (${cfopsEf},${cfopsRem}) AND ${baseC5}
       GROUP BY d2.D2_PEDIDO, d2.D2_COD, CASE WHEN d2.D2_CF IN (${cfopsEf}) THEN 'ef' ELSE 'rem' END`, params)
  ]);
  return { cab, itens, nfs, qtd };
}

// Junta dois conjuntos lidos do Protheus sem repetir pedido.
function juntarDados(a, b) {
  const nums = new Set(a.cab.map(c => trim(c.num)));
  const novo = (r) => !nums.has(trim(r.num));
  return {
    cab: [...a.cab, ...b.cab.filter(novo)],
    itens: [...a.itens, ...b.itens.filter(novo)],
    nfs: [...a.nfs, ...b.nfs.filter(novo)],
    qtd: [...a.qtd, ...b.qtd.filter(novo)]
  };
}

async function lerEntregas(app, chaves) {
  const { Pg } = app.services;
  const mapa = new Map();
  const lista = [...new Set(chaves.filter(c => /^\d{44}$/.test(c)))];
  // Em lotes: o wrapper do Pg traduz @param um a um.
  for (let i = 0; i < lista.length; i += 500) {
    const lote = lista.slice(i, i + 500);
    const p = {}; const marcas = lote.map((c, j) => { p[`c${j}`] = c; return `@c${j}`; });
    const rows = await Pg.connectAndQuery(
      `SELECT chave_nf, entregue, dt_evento, descricao FROM tab_nf_entrega WHERE chave_nf IN (${marcas.join(',')})`, p);
    rows.forEach(r => mapa.set(trim(r.chave_nf), r));
  }
  return mapa;
}

async function lerSync(app) {
  const { Pg } = app.services;
  const r = await Pg.connectAndQuery(`SELECT ultima_ok, ultima_tentativa, ultimo_erro FROM tab_nf_entrega_sync WHERE id = 1`, {});
  return r[0] || null;
}

// De-para BU -> equipe da Cobrança. `porNome` resolve BU sem de-para cujo nome já é
// o de uma equipe com outra grafia (ex.: "Assistencia Tecnica" x "Assistência Técnica").
async function lerEquipes(app) {
  const { Pg } = app.services;
  const rows = await Pg.connectAndQuery(`SELECT bu_codigo, equipe FROM tab_cobranca_bu_equipe`, {});
  const porBu = new Map(rows.map(r => [trim(r.bu_codigo), trim(r.equipe)]));
  const porNome = new Map(rows.map(r => [normalizar(r.equipe), trim(r.equipe)]));
  return { porBu, porNome };
}

// ---------------------------------------------------------------------------
// Entrega futura: liga cada pedido de remessa à venda (ver cabeçalho).
// ---------------------------------------------------------------------------
function ligarRemessas(cab, nfsPorPed) {
  const cabPorNum = new Map(cab.map(c => [trim(c.num), c]));
  const cliente = (c) => `${trim(c.cli)}|${trim(c.loja)}`;
  const vendaPorNf = new Map();      // nº da NF de venda sem zeros -> pedido
  const vendasDoCliente = new Map(); // cliente|loja -> [{ num, emissao }]
  for (const [num, nfs] of nfsPorPed) {
    const c = cabPorNum.get(num);
    const ef = nfs.filter(n => N(n.ef) === 1);
    if (!c || !ef.length) continue;
    ef.forEach(n => vendaPorNf.set(String(Number(trim(n.doc))), num));
    const lista = vendasDoCliente.get(cliente(c)) || [];
    lista.push({ num, emissao: ef.map(n => trim(n.emissao)).sort()[0] });
    vendasDoCliente.set(cliente(c), lista);
  }

  const remessasPorVenda = new Map();
  const vendaDaRemessa = new Map();
  for (const [num, nfs] of nfsPorPed) {
    const c = cabPorNum.get(num);
    const rem = nfs.filter(n => N(n.rem) === 1);
    if (!c || !rem.length) continue;
    let venda = null, vinculo = null;
    const refs = [...trim(c.mennota).matchAll(RE_NF_REFERENCIA)].map(m => String(Number(m[1])));
    for (const ref of refs) {
      const v = vendaPorNf.get(ref);
      if (v && cliente(cabPorNum.get(v)) === cliente(c)) { venda = v; vinculo = 'nota'; break; }
    }
    // Sem mensagem: só liga pelo cliente quando não há dúvida. Se a mensagem cita uma
    // NF que não está carregada, a venda é outra — não chuta.
    if (!venda && !refs.length) {
      const vendas = vendasDoCliente.get(cliente(c)) || [];
      const emRemessa = rem.map(n => trim(n.emissao)).sort()[0];
      if (vendas.length === 1 && vendas[0].emissao <= emRemessa) { venda = vendas[0].num; vinculo = 'cliente'; }
    }
    if (!venda) continue;
    vendaDaRemessa.set(num, { num: venda, vinculo });
    if (!remessasPorVenda.has(venda)) remessasPorVenda.set(venda, []);
    remessasPorVenda.get(venda).push({ num, vinculo });
  }
  return { remessasPorVenda, vendaDaRemessa };
}

// Produtos vendidos na NF de entrega futura que as remessas ainda não cobriram.
function faltaRemessar(qtdVenda, remessas) {
  const somar = (rows) => rows.reduce((m, r) => m.set(trim(r.produto), (m.get(trim(r.produto)) || 0) + N(r.qtd)), new Map());
  const vendido = somar(qtdVenda.filter(r => r.tipo === 'ef'));
  const enviado = somar(remessas.flatMap(r => r.qtd.filter(x => x.tipo === 'rem')));
  return [...vendido]
    .filter(([p, q]) => (enviado.get(p) || 0) < q)
    .map(([produto, vendidoQtd]) => ({ produto, vendido: vendidoQtd, enviado: enviado.get(produto) || 0 }));
}

// ---------------------------------------------------------------------------
// Monta um pedido: etapa, entrada, SLA e dados para a linha do tempo.
// ---------------------------------------------------------------------------
function mapearNf(n, entregas, pedidoRemessa = null) {
  const ent = entregas.get(trim(n.chave));
  return {
    doc: trim(n.doc), serie: trim(n.serie), chave: trim(n.chave),
    emissaoTs: tsProtheus(n.emissao, n.hora), fisica: N(n.fisica) === 1,
    entregaFutura: N(n.ef) === 1, remessaFutura: N(n.rem) === 1,
    transportadora: trim(n.transp), rastreio: trim(n.rastreio),
    expedicao: /^\d{8}$/.test(trim(n.expedicao)) ? trim(n.expedicao) : null,
    entregue: !!(ent && ent.entregue),
    entregaTs: ent && ent.entregue ? tsPg(ent.dt_evento) : null,
    ultimoEvento: ent ? trim(ent.descricao) : null,
    ultimoEventoTs: ent ? tsPg(ent.dt_evento) : null,
    pedidoRemessa
  };
}

// Depois do faturamento, a etapa sai das NFs físicas: expedição -> transporte -> entregue.
function etapaDasNotas(fisicas) {
  if (fisicas.some(n => !n.expedicao)) {
    return { etapa: 'expedicao', entrada: maxTs(fisicas.map(n => n.emissaoTs)), entradaSemHora: false, semRastreio: false };
  }
  const pendentes = fisicas.filter(n => !n.entregue);
  if (pendentes.length) {
    return {
      etapa: 'transporte',
      entrada: maxTs(fisicas.map(n => tsProtheus(n.expedicao, '00:00'))),
      entradaSemHora: true,
      semRastreio: pendentes.every(n => TRANSP_SEM_RASTREIO.test(n.transportadora))
    };
  }
  return {
    etapa: 'entregue',
    entrada: maxTs(fisicas.map(n => n.entregaTs)) ?? maxTs(fisicas.map(n => n.emissaoTs)),
    entradaSemHora: false, semRastreio: false
  };
}

function montarPedido(c, dados, ctx) {
  const { cfg, equipes, entregas, agora } = ctx;

  // Itens com resíduo eliminado (C6_BLQ='R') são cancelamento: não contam.
  const itens = dados.itens.filter(i => trim(i.blq) !== 'R');
  if (!itens.length) return null;

  const emissaoData = tsProtheus(c.emissao, '00:00');
  const insBr = insParaBrasilia(c.ins);
  // A hora da emissão só existe quando o registro tem I_N_S_D_T_ do mesmo dia.
  const emissaoTs = insBr != null && fmtTs(insBr).slice(0, 10) === fmtData(c.emissao) ? insBr : emissaoData;
  const emissaoSemHora = emissaoTs === emissaoData;

  // Carimbos de liberação; qualquer um anterior à emissão é lixo de outro ciclo.
  const carimbo = (d, h) => { const t = tsProtheus(d, h); return t != null && t >= emissaoData ? t : null; };
  const lib = {
    comercial: carimbo(c.d1, c.h1), financeiro: carimbo(c.dfi, c.hfi), planejamento: carimbo(c.dpl, c.hpl),
    formulacao: carimbo(c.dri, c.hri), estoque: carimbo(c.des, c.hes)
  };

  const valor = itens.reduce((s, i) => s + N(i.valor), 0);
  const prometidas = itens.map(i => trim(i.entreg)).filter(d => /^\d{8}$/.test(d)).sort();
  const dataPrometida = prometidas.length ? prometidas[0] : null;

  const abertos = itens.filter(i => N(i.qtdEnt) < N(i.qtdVen));
  const faturadosParcial = itens.some(i => N(i.qtdEnt) > 0);

  const nfs = dados.nfs.map(n => mapearNf(n, entregas));
  const remessas = dados.remessas || [];
  const nfsRemessa = remessas.flatMap(r => r.nfs.map(n => mapearNf(n, entregas, r.num)));

  let etapa, entrada, entradaSemHora = false, estimado = false, desconhecido = false, semRastreio = false;
  let entregaFutura = false, aguardandoRemessa = false, falta = [];

  if (abertos.length) {
    // Estágio de cada item em aberto. '04' é bloqueio de crédito que a view não
    // mapeia (cai em "Desconhecido") — mesma correção da Liberação Financeira.
    const codigos = abertos.map(i => (trim(i.blcred) === '04' ? 20 : N(i.cod)));
    const etapasItens = codigos.map(k => ETAPA_POR_ESTATUS[k]).filter(Boolean);
    if (etapasItens.length) {
      // Pedido com itens em etapas diferentes fica na mais atrasada.
      etapa = etapasItens.sort((a, b) => ORDEM[a] - ORDEM[b])[0];
    } else if (codigos.every(k => k === 99)) {
      // Saldo de item parcialmente faturado ainda sem nova liberação: aguarda o comercial.
      etapa = 'comercial';
    } else {
      etapa = 'comercial';
      desconhecido = true;
    }
    entrada = maxTs([emissaoTs, ...Object.values(lib)]);
    entradaSemHora = entrada === emissaoTs && emissaoSemHora;
    // Estimado quando há carimbo de etapa igual ou POSTERIOR à atual: o pedido voltou.
    const posteriores = ETAPAS.slice(ORDEM[etapa], ORDEM.faturamento).map(e => lib[e.codigo]).filter(t => t != null);
    estimado = posteriores.length > 0 && etapa !== 'faturamento';
  } else {
    const fisicas = nfs.filter(n => n.fisica);
    const ultimaNf = maxTs(nfs.map(n => n.emissaoTs));
    let r;
    if (!nfs.length) {
      // Faturado sem NF localizada (raro): não dá para seguir a remessa.
      r = { etapa: 'expedicao', entrada: emissaoTs }; estimado = true;
    } else if (!fisicas.length && nfs.some(n => n.entregaFutura)) {
      // Venda para entrega futura: o físico sai no pedido de remessa.
      entregaFutura = true;
      const fisRemessa = nfsRemessa.filter(n => n.fisica);
      if (!fisRemessa.length) {
        r = { etapa: 'expedicao', entrada: ultimaNf };
        aguardandoRemessa = true;
      } else {
        r = etapaDasNotas(fisRemessa);
        falta = faltaRemessar(dados.qtd || [], remessas);
      }
    } else if (!fisicas.length) {
      // Só NF sem remessa física (serviço, venda à ordem): o ciclo termina no faturamento.
      r = { etapa: 'entregue', entrada: ultimaNf };
    } else {
      r = etapaDasNotas(fisicas);
    }
    etapa = r.etapa; entrada = r.entrada; entradaSemHora = !!r.entradaSemHora; semRastreio = !!r.semRastreio;
  }

  // Sem nenhuma data utilizável (NF sem emissão, entrega sem data): cai na emissão
  // do pedido e sinaliza, em vez de mostrar tempo absurdo ou "NaN".
  if (entrada == null || !isFinite(entrada)) {
    entrada = emissaoTs;
    entradaSemHora = emissaoSemHora;
    estimado = true;
  }

  const horasNaEtapa = Math.max(0, (agora - entrada) / HORA);
  // Aguardando remessa não tem semáforo: quem decide a data é o cliente.
  const slaHoras = etapa === 'entregue' || aguardandoRemessa ? null : (cfg.sla[etapa] || null);
  const slaPct = slaHoras ? (horasNaEtapa / slaHoras) * 100 : null;
  const sla = slaPct == null ? null : slaPct > 100 ? 'vermelho' : slaPct >= cfg.amareloPct ? 'amarelo' : 'verde';

  const buLabel = trim(c.buNome) || (trim(c.buCod) ? `${trim(c.buCod)} (Desconhecido)` : '');
  const hojeData = protheusData(agora);
  const prometidaFim = dataPrometida ? tsProtheus(dataPrometida, '23:59') : null;

  return {
    num: trim(c.num),
    cliente: { cod: trim(c.cli), loja: trim(c.loja), nome: trim(c.cliNome), uf: trim(c.uf) },
    vendedor: { cod: trim(c.vend), nome: trim(c.vendNome) },
    bu: buLabel,
    // BU sem de-para (ex.: GNATUS SERVICE) usa o próprio nome, para caber no filtro.
    equipe: equipes.porBu.get(buLabel) || equipes.porNome.get(normalizar(buLabel)) || buLabel || null,
    valor: Number(valor.toFixed(2)),
    curvaA: valor >= cfg.curvaAValor,
    etapa,
    entrada: fmtTs(entrada),
    entradaSemHora,
    estimado,
    desconhecido,
    semRastreio,
    entregaFutura,
    aguardandoRemessa,
    remessaParcial: falta.length > 0,
    remessas: remessas.map(r => ({ num: r.num, vinculo: r.vinculo })),
    // Pedido de remessa de entrega futura; vendaOrigem quando a venda foi identificada.
    pedidoDeRemessa: nfs.some(n => n.remessaFutura),
    vendaOrigem: dados.vendaOrigem || null,
    parcial: abertos.length > 0 && faturadosParcial,
    horasNaEtapa: Number(horasNaEtapa.toFixed(1)),
    slaHoras,
    slaPct: slaPct != null ? Number(slaPct.toFixed(0)) : null,
    sla,
    dataPrometida: fmtData(dataPrometida),
    prazoVencido: etapa !== 'entregue' && !!dataPrometida && hojeData > dataPrometida,
    entregueComAtraso: etapa === 'entregue' && prometidaFim != null && entrada > prometidaFim,
    // Para o detalhe
    _det: { emissaoTs, emissaoSemHora, lib, usuarioLib1: trim(c.u1), itens, nfs, nfsRemessa, falta }
  };
}

function agruparPorPedido(rows) {
  const m = new Map();
  rows.forEach(r => { const k = trim(r.num); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  return m;
}

// Monta todos os pedidos de um conjunto lido do Protheus, já com as remessas ligadas.
function montarPedidos(dados, ctx) {
  const itensPorPed = agruparPorPedido(dados.itens);
  const nfsPorPed = agruparPorPedido(dados.nfs);
  const qtdPorPed = agruparPorPedido(dados.qtd);
  const { remessasPorVenda, vendaDaRemessa } = ligarRemessas(dados.cab, nfsPorPed);
  return dados.cab.map(c => {
    const num = trim(c.num);
    const remessas = (remessasPorVenda.get(num) || []).map(r => ({
      ...r, nfs: nfsPorPed.get(r.num) || [], qtd: qtdPorPed.get(r.num) || []
    }));
    return montarPedido(c, {
      itens: itensPorPed.get(num) || [], nfs: nfsPorPed.get(num) || [], qtd: qtdPorPed.get(num) || [],
      remessas, vendaOrigem: vendaDaRemessa.get(num) || null
    }, ctx);
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Lista do Kanban
// ---------------------------------------------------------------------------
// A leitura do período leva 3 a 5 s; filtros, busca e "ver todos" reaproveitam os
// pedidos já montados por 90 s. Salvar a configuração limpa o cache.
const CACHE_MS = 90e3;
const cachePeriodo = new Map(); // 'ini|fim' -> { em, agora, pedidos }
const limparCache = () => cachePeriodo.clear();

async function pedidosDoPeriodo(app, cfg, iniIso, fimIso) {
  const chave = `${iniIso}|${fimIso}`;
  const guardado = cachePeriodo.get(chave);
  if (guardado && Date.now() - guardado.em < CACHE_MS) return guardado;

  const ini = iniIso.replace(/-/g, '');
  const fim = fimIso.replace(/-/g, '');
  const emissaoMin = protheusData(tsProtheus(ini, '00:00') - 365 * 24 * HORA);
  const [lidos, remessasFora, equipes] = await Promise.all([
    lerProtheus(app, { ini, fim }),
    // Só entram para ligar a uma venda do período, nunca como card.
    lerProtheus(app, { remessaNfDesde: ini, foraIni: ini, foraFim: fim, emissaoMin }),
    lerEquipes(app)
  ]);
  const soParaLigar = new Set(remessasFora.cab.map(c => trim(c.num)));
  const dados = juntarDados(lidos, remessasFora);
  const entregas = await lerEntregas(app, dados.nfs.map(n => trim(n.chave)));
  const agora = agoraBrasilia();

  const montados = montarPedidos(dados, { cfg, equipes, entregas, agora }).filter(p => !soParaLigar.has(p.num));
  const noPainel = new Set(montados.map(p => p.num));
  const pedidos = montados.filter(p =>
    !BUS_FORA_DO_PAINEL.has(normalizar(p.bu)) &&
    // Remessa ligada a uma venda que está no painel aparece dentro do card da venda.
    !(p.vendaOrigem && noPainel.has(p.vendaOrigem.num)));

  const novo = { em: Date.now(), agora, pedidos };
  for (const [k, v] of cachePeriodo) if (Date.now() - v.em >= CACHE_MS) cachePeriodo.delete(k);
  cachePeriodo.set(chave, novo);
  return novo;
}

async function montarKanban(app, filtros = {}) {
  const cfg = await carregarConfig(app);
  const iso = (ts) => fmtTs(ts).slice(0, 10);
  const deIso = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const hojeIso = iso(agoraBrasilia());
  const fimIso = /^\d{4}-\d{2}-\d{2}$/.test(trim(filtros.fim)) && trim(filtros.fim) < hojeIso ? trim(filtros.fim) : hojeIso;
  const iniIso = /^\d{4}-\d{2}-\d{2}$/.test(trim(filtros.ini)) && trim(filtros.ini) <= fimIso
    ? trim(filtros.ini) : iso(deIso(fimIso) - cfg.periodoPadraoDias * 24 * HORA);

  const [base, sync] = await Promise.all([pedidosDoPeriodo(app, cfg, iniIso, fimIso), lerSync(app)]);
  let pedidos = base.pedidos;

  // Opções dos filtros saem do universo do período, antes de filtrar.
  const vendedores = [...new Map(pedidos.filter(p => p.vendedor.cod).map(p => [p.vendedor.cod, p.vendedor])).values()]
    .sort((a, b) => a.nome.localeCompare(b.nome));
  const equipesOpc = [...new Set(pedidos.map(p => p.equipe).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const busca = trim(filtros.busca).toUpperCase();
  const buscaNum = /^\d{1,6}$/.test(busca) ? busca.padStart(6, '0') : null;
  pedidos = pedidos.filter(p =>
    (!trim(filtros.vendedor) || p.vendedor.cod === trim(filtros.vendedor)) &&
    (!trim(filtros.equipe) || p.equipe === trim(filtros.equipe)) &&
    (!filtros.curvaA || p.curvaA) &&
    (!filtros.estourado || p.sla === 'vermelho') &&
    (!busca || (buscaNum
      ? p.num === buscaNum || p.remessas.some(r => r.num === buscaNum)
      : p.cliente.nome.toUpperCase().includes(busca)))
  );

  const limite = Math.min(500, Math.max(1, N(filtros.limite) || 40));
  const soEtapa = trim(filtros.etapa);
  const semSemaforo = (p) => (p.semRastreio || p.aguardandoRemessa ? 1 : 0);
  const etapas = ETAPAS.map(e => {
    const lista = pedidos.filter(p => p.etapa === e.codigo);
    // Mais crítico primeiro (sem rastreio / aguardando remessa no fim); na coluna
    // Entregue, os mais recentes.
    lista.sort((a, b) => e.codigo === 'entregue'
      ? String(b.entrada).localeCompare(String(a.entrada))
      : (semSemaforo(a) - semSemaforo(b)) || (N(b.slaPct) - N(a.slaPct)) || (b.horasNaEtapa - a.horasNaEtapa));
    const mostrar = soEtapa ? (soEtapa === e.codigo ? lista.length : 0) : limite;
    return {
      codigo: e.codigo, nome: e.nome, slaHoras: cfg.sla[e.codigo] || null,
      total: lista.length,
      estourados: lista.filter(p => p.sla === 'vermelho').length,
      emRisco: lista.filter(p => p.sla === 'amarelo').length,
      semRastreio: lista.filter(p => p.semRastreio).length,
      aguardandoRemessa: lista.filter(p => p.aguardandoRemessa).length,
      valor: Number(lista.reduce((s, p) => s + p.valor, 0).toFixed(2)),
      cards: lista.slice(0, mostrar).map(({ _det, ...card }) => card)
    };
  });

  const andamento = pedidos.filter(p => p.etapa !== 'entregue');
  return {
    periodo: { ini: iniIso, fim: fimIso },
    config: { curvaAValor: cfg.curvaAValor, amareloPct: cfg.amareloPct, periodoPadraoDias: cfg.periodoPadraoDias },
    kpis: {
      total: pedidos.length,
      emAndamento: andamento.length,
      estourados: andamento.filter(p => p.sla === 'vermelho').length,
      emRisco: andamento.filter(p => p.sla === 'amarelo').length,
      entregues: pedidos.length - andamento.length,
      prazoVencido: andamento.filter(p => p.prazoVencido).length,
      curvaA: pedidos.filter(p => p.curvaA).length,
      desconhecidos: pedidos.filter(p => p.desconhecido).length,
      estimados: pedidos.filter(p => p.estimado).length,
      semRastreio: andamento.filter(p => p.semRastreio).length,
      estouradosSemRastreio: andamento.filter(p => p.semRastreio && p.sla === 'vermelho').length,
      aguardandoRemessa: andamento.filter(p => p.aguardandoRemessa).length
    },
    desconhecidos: pedidos.filter(p => p.desconhecido).map(p => p.num),
    etapas,
    opcoes: { vendedores, equipes: equipesOpc },
    entregas: sync ? { ultimaOk: sync.ultima_ok, ultimaTentativa: sync.ultima_tentativa, ultimoErro: sync.ultimo_erro } : null,
    geradoEm: fmtTs(base.agora)
  };
}

// ---------------------------------------------------------------------------
// Detalhe de um pedido, com a linha do tempo completa
// ---------------------------------------------------------------------------
async function detalharPedido(app, num) {
  const n = trim(num).replace(/\D/g, '').padStart(6, '0');
  const cfg = await carregarConfig(app);
  const [lido, equipes] = await Promise.all([lerProtheus(app, { num: n }), lerEquipes(app)]);
  if (!lido.cab.length) return null;

  // Venda ou remessa de entrega futura: carrega as do mesmo cliente para ligar.
  let dados = lido;
  if (lido.nfs.some(x => N(x.ef) === 1 || N(x.rem) === 1)) {
    const c = lido.cab[0];
    const desde = protheusData(tsProtheus(c.emissao, '00:00') - 180 * 24 * HORA);
    dados = juntarDados(lido, await lerProtheus(app, { cli: c.cli, loja: c.loja, desde }));
  }
  const entregas = await lerEntregas(app, dados.nfs.map(x => trim(x.chave)));
  const agora = agoraBrasilia();
  const p = montarPedidos(dados, { cfg, equipes, entregas, agora }).find(x => x.num === n);
  if (!p) return { num: n, cancelado: true };

  const { _det, ...card } = p;
  const fisicas = card.entregaFutura ? _det.nfsRemessa.filter(x => x.fisica) : _det.nfs.filter(x => x.fisica);
  const faturamentoTs = maxTs(_det.nfs.map(x => x.emissaoTs));
  const expedicaoTs = fisicas.length && fisicas.every(x => x.expedicao) ? maxTs(fisicas.map(x => tsProtheus(x.expedicao, '00:00'))) : null;
  const entregaTs = fisicas.length && fisicas.every(x => x.entregue) ? maxTs(fisicas.map(x => x.entregaTs)) : null;

  // Marcos na ordem do fluxo. "saida" = quando o pedido deixou a etapa.
  const marcos = [
    { etapa: 'comercial',    nome: 'Liberação comercial',            saida: _det.lib.comercial, usuario: _det.usuarioLib1 || null },
    { etapa: 'financeiro',   nome: 'Análise financeira',             saida: _det.lib.financeiro },
    { etapa: 'planejamento', nome: 'Liberação de planejamento',      saida: _det.lib.planejamento },
    { etapa: 'formulacao',   nome: 'Formulação financeira',          saida: _det.lib.formulacao },
    { etapa: 'estoque',      nome: 'Liberação de estoque',           saida: _det.lib.estoque },
    { etapa: 'faturamento',  nome: 'Aguardando faturamento',         saida: faturamentoTs },
    { etapa: 'expedicao',    nome: card.entregaFutura ? 'Faturado, aguardando remessa e expedição' : 'Faturado, aguardando expedição',
      saida: expedicaoTs, saidaSemHora: true },
    { etapa: 'transporte',   nome: 'Em transporte',                  saida: entregaTs }
  ];
  const idxAtual = ORDEM[card.etapa];
  let entradaAnterior = _det.emissaoTs;
  const linhaDoTempo = [{ etapa: 'emissao', nome: 'Pedido emitido', em: fmtTs(_det.emissaoTs), semHora: _det.emissaoSemHora, situacao: 'concluida' }];
  marcos.forEach((m, i) => {
    let situacao;
    if (i < idxAtual) situacao = m.saida != null ? 'concluida' : 'sem_passagem';
    else if (i === idxAtual) situacao = 'atual';
    else situacao = 'futura';
    const duracao = situacao === 'concluida' && entradaAnterior != null && m.saida >= entradaAnterior
      ? Number(((m.saida - entradaAnterior) / HORA).toFixed(1)) : null;
    linhaDoTempo.push({
      etapa: m.etapa, nome: m.nome, situacao,
      saida: situacao === 'concluida' ? fmtTs(m.saida) : null,
      saidaSemHora: !!m.saidaSemHora,
      duracaoHoras: duracao,
      // Na entrega futura esse trecho inclui a espera pela remessa, que não tem SLA.
      slaHoras: card.entregaFutura && m.etapa === 'expedicao' ? null : (cfg.sla[m.etapa] || null),
      usuario: situacao === 'concluida' ? (m.usuario || null) : null,
      entrada: situacao === 'atual' ? card.entrada : null
    });
    if (situacao === 'concluida') entradaAnterior = m.saida;
  });
  if (card.etapa === 'entregue') {
    linhaDoTempo.push({ etapa: 'entregue', nome: 'Entregue', situacao: 'concluida', em: card.entrada });
  }

  const nota = (x) => ({
    doc: x.doc, serie: x.serie, pedido: x.pedidoRemessa || card.num, emissao: fmtTs(x.emissaoTs),
    fisica: x.fisica, entregaFutura: x.entregaFutura,
    transportadora: x.transportadora, rastreio: x.rastreio, expedicao: fmtData(x.expedicao),
    entregue: x.entregue, entrega: fmtTs(x.entregaTs), ultimoEvento: x.ultimoEvento, ultimoEventoEm: fmtTs(x.ultimoEventoTs)
  });

  return {
    ...card,
    linhaDoTempo,
    itens: _det.itens.map(i => ({
      item: trim(i.item), produto: trim(i.produto), descricao: trim(i.descricao),
      qtdVendida: N(i.qtdVen), qtdFaturada: N(i.qtdEnt), valor: N(i.valor),
      entregaPrometida: fmtData(i.entreg)
    })),
    notas: [..._det.nfs.map(nota), ..._det.nfsRemessa.map(nota)],
    faltaRemessar: _det.falta
  };
}

module.exports = { ETAPAS, carregarConfig, sincronizarEntregas, montarKanban, detalharPedido, limparCache };

// services/portalEspelho.js — monta e publica o que o CLIENTE pode ver no portal.
//
// O portal do cliente não vive na intranet e não consulta o Protheus nem esta
// base: a intranet monta o espelho aqui e EMPURRA para lá. Um problema no site
// público não alcança o ERP. (Decisão do usuário, 09/10/2026.)
//
// Escopo: títulos de VENDA (natureza 10101/10201), filial 01, sem RA/NCC — os em
// aberto e os liquidados nos últimos 12 meses. Medido: ~13,1 mil abertos +
// ~27,1 mil pagos = ~40 mil linhas de 4,1 mil clientes.
//
// A regra que mais importa está em `pode2via`: só sai 2ª via de boleto
// registrado, AINDA NÃO VENCIDO e não cedido a fundo. Vencido é tratado pelo
// financeiro (decisão do usuário) e cedido tem outro beneficiário no código de
// barras — entregar a 2ª via da Gnatus nesse caso mandaria o cliente pagar a
// pessoa errada.
//
// Publicação: POST em `${PORTAL_URL}/espelho` com `Authorization: Bearer
// ${PORTAL_TOKEN}`. Sem essas variáveis o motor roda e grava o espelho, mas não
// envia nada (status `inerte`) — é o mesmo padrão dos outros integradores da
// casa, para o código poder subir antes de o portal existir.

const ProtheusBoleto = require('./protheusBoleto');
const PortadorCessao = require('./portadorCessao');
const LinhaDigitavel = require('./linhaDigitavel');

const trim = (v) => String(v == null ? '' : v).trim();
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const n2 = (v) => Math.round(N(v) * 100) / 100;
const dataIso = (s) => { const v = soDig(s); return v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null; };

const MESES_HISTORICO = 12;

// Telefone: regra que o NPS e o aviso de expedição já usam. A1_DDDCEL guarda SÓ
// o DDD; o número vem de A1_TEL. Não existe A1_CELULAR nesta base.
function telefoneDe(ddd, dddcel, tel) {
  const n = soDig(tel);
  const d = soDig(ddd) || soDig(dddcel);
  if (!n || !d) return null;
  return (d + n).replace(/^0+/, '');
}

// A1_EMAIL guarda VÁRIOS endereços separados por ; ou , (visto na base: três
// e-mails numa linha só). O código de acesso vai para UM destino, então fica o
// primeiro que parece e-mail — e o resto não é publicado, que é dado de contato
// comercial que o portal não precisa ter.
function emailDe(bruto) {
  const partes = String(bruto || '').split(/[;,\s]+/).map(s => s.trim()).filter(Boolean);
  const valido = partes.find(p => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(p));
  return valido ? valido.slice(0, 120).toLowerCase() : null;
}

const chave = (r) => [trim(r.prefixo), trim(r.numero), trim(r.parcela), trim(r.cliente_cod), trim(r.cliente_loja)].join('|');

// ---------------------------------------------------------------- leitura
async function lerTitulos(Protheus) {
  return Protheus.connectAndQuery(`
    SELECT RTRIM(se1.E1_PREFIXO) prefixo, RTRIM(se1.E1_NUM) numero, RTRIM(se1.E1_PARCELA) parcela,
           RTRIM(se1.E1_TIPO) tipo, RTRIM(se1.E1_CLIENTE) cliente_cod, RTRIM(se1.E1_LOJA) cliente_loja,
           RTRIM(COALESCE(NULLIF(RTRIM(sa1.A1_NOME), ''), se1.E1_NOMCLI)) cliente_nome,
           REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(sa1.A1_CGC, '')), '.', ''), '/', ''), '-', '') cliente_doc,
           RTRIM(ISNULL(sa1.A1_EMAIL, '')) email,
           RTRIM(ISNULL(sa1.A1_DDD, '')) ddd, RTRIM(ISNULL(sa1.A1_DDDCEL, '')) dddcel,
           RTRIM(ISNULL(sa1.A1_TEL, '')) tel,
           se1.E1_EMISSAO emissao, se1.E1_VENCREA vencimento, RTRIM(ISNULL(se1.E1_VENCTO,'')) vencto_original,
           se1.E1_VALOR valor, se1.E1_SALDO saldo,
           RTRIM(ISNULL(se1.E1_BAIXA, '')) baixa, se1.E1_VALLIQ valor_pago,
           RTRIM(ISNULL(se1.E1_PORTADO, '')) portador,
           DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), CONVERT(date, GETDATE())) atraso
      FROM SE1010 se1 WITH (NOLOCK)
      LEFT JOIN SA1010 sa1 WITH (NOLOCK)
             ON sa1.A1_FILIAL = se1.E1_FILIAL AND sa1.A1_COD = se1.E1_CLIENTE
            AND sa1.A1_LOJA = se1.E1_LOJA AND sa1.D_E_L_E_T_ <> '*'
     WHERE se1.D_E_L_E_T_ <> '*' AND se1.E1_FILIAL = '01'
       AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
       AND RTRIM(se1.E1_NATUREZ) IN ('10101','10201')
       AND (se1.E1_SALDO > 0
            OR se1.E1_BAIXA >= CONVERT(char(8), DATEADD(month, -${MESES_HISTORICO}, GETDATE()), 112))`, {});
}

// Boletos que a intranet conhece, com as coordenadas do banco do lote.
async function lerBoletos(Pg) {
  const linhas = await Pg.connectAndQuery(
    `SELECT r.prefixo, r.numero, r.parcela, r.cliente_cod, r.cliente_loja,
            r.nosso_numero, r.status_banco,
            l.banco_cod, l.banco_agencia, l.banco_conta
       FROM tab_boleto_envio_lote_retorno r
       JOIN tab_boleto_envio_lote l ON l.id = r.id_lote
      WHERE COALESCE(r.nosso_numero, '') <> ''`, {});
  const mapa = new Map();
  linhas.forEach(b => mapa.set(chave(b), b));
  return mapa;
}

// ---------------------------------------------------------------- montagem
async function montar(app) {
  const { Protheus, Pg } = app.services;
  const [titulos, boletos] = await Promise.all([lerTitulos(Protheus), lerBoletos(Pg)]);

  const itens = [];
  for (const t of titulos) {
    const pago = N(t.saldo) <= 0;
    const situacao = pago ? 'pago' : (N(t.atraso) >= 1 ? 'vencido' : 'a_vencer');
    const b = boletos.get(chave(t));
    const temBoleto = !!b && trim(b.status_banco) === 'REGISTRADO';

    let pode2via = false, motivo = null, linha = null, barras = null, nossoNumero = null, banco = null;

    if (temBoleto) {
      banco = trim(b.banco_cod);
      nossoNumero = LinhaDigitavel.formatarNossoNumero(banco, b.nosso_numero);
    }

    if (pago) {
      motivo = null;                                   // nada a pagar; o portal só mostra o histórico
    } else if (!temBoleto) {
      motivo = 'Sem boleto gerado — fale com a cobrança';
    } else if (situacao === 'vencido') {
      // Decisão do usuário: 2ª via de vencido é do financeiro (mora, multa e,
      // dependendo do caso, novo registro no banco).
      motivo = 'Boleto vencido — solicite a 2ª via à cobrança';
    } else {
      const bko = PortadorCessao.dadosBoleto({
        banco: trim(b.banco_cod), agencia: trim(b.banco_agencia), conta: trim(b.banco_conta)
      });
      if (bko.cessao) {
        // Cedido a fundo: quem recebe é o fundo, com outro beneficiário no código
        // de barras. Nunca entregar a 2ª via da Gnatus aqui.
        motivo = 'Título cedido — fale com a cobrança';
      } else if (bko.boletoPendente) {
        motivo = 'Boleto não configurado — fale com a cobrança';
      } else {
        try {
          const r = await ProtheusBoleto.linhaDigitavel({
            banco: bko.banco, agencia: bko.agencia, conta: bko.conta, carteira: bko.carteira,
            nossoNumero: trim(b.nosso_numero),
            valor: N(t.valor),
            vencimento: trim(t.vencto_original) || trim(t.vencimento)
          });
          linha = trim(r.body?.linha_digitavel) || null;
          barras = trim(r.body?.codigo_barras) || null;
          pode2via = !!(r.ok && linha && barras);
          if (!pode2via) motivo = 'Não foi possível montar o boleto — fale com a cobrança';
        } catch (e) {
          motivo = 'Não foi possível montar o boleto — fale com a cobrança';
        }
      }
    }

    itens.push({
      ref: chave(t),
      cliente_doc: soDig(t.cliente_doc),
      cliente_cod: trim(t.cliente_cod), cliente_loja: trim(t.cliente_loja),
      cliente_nome: trim(t.cliente_nome),
      contato_telefone: telefoneDe(t.ddd, t.dddcel, t.tel),
      contato_email: emailDe(t.email),
      prefixo: trim(t.prefixo), numero: trim(t.numero), parcela: trim(t.parcela), tipo: trim(t.tipo),
      emissao: dataIso(t.emissao), vencimento: dataIso(t.vencimento),
      valor: n2(t.valor), saldo: n2(t.saldo),
      situacao,
      data_pagamento: pago ? dataIso(t.baixa) : null,
      valor_pago: pago ? n2(t.valor_pago) : null,
      tem_boleto: temBoleto, banco, nosso_numero: nossoNumero,
      linha_digitavel: linha, codigo_barras: barras,
      pode_2via: pode2via, motivo_2via: motivo
    });
  }

  // Cliente sem documento não consegue entrar (o login é por CPF/CNPJ), então
  // publicar a linha dele só espalharia dado sem servir para nada.
  const publicaveis = itens.filter(i => i.cliente_doc.length === 11 || i.cliente_doc.length === 14);

  // Duas linhas com a mesma ref no mesmo lote fazem o ON CONFLICT estourar
  // ("cannot affect row a second time"). Fica a ultima.
  const unicos = [...new Map(publicaveis.map(i => [i.ref, i])).values()];

  return {
    itens: unicos,
    resumo: {
      titulos: unicos.length,
      descartados_sem_documento: itens.length - publicaveis.length,
      clientes: new Set(unicos.map(i => i.cliente_doc)).size,
      com_boleto: unicos.filter(i => i.tem_boleto).length,
      com_2via: unicos.filter(i => i.pode_2via).length,
      refs_repetidas: publicaveis.length - unicos.length
    }
  };
}

// ---------------------------------------------------------------- gravação
const COLUNAS = [
  'ref', 'cliente_doc', 'cliente_cod', 'cliente_loja', 'cliente_nome', 'contato_telefone',
  'contato_email', 'prefixo', 'numero', 'parcela', 'tipo', 'emissao', 'vencimento', 'valor',
  'saldo', 'situacao', 'data_pagamento', 'valor_pago', 'tem_boleto', 'banco', 'nosso_numero',
  'linha_digitavel', 'codigo_barras', 'pode_2via', 'motivo_2via'
];

// Em LOTES: são ~40 mil títulos, e uma ida ao banco por linha derrubava a
// conexão antes de terminar. 400 por vez dá ~10 mil parâmetros por chamada,
// bem abaixo do teto do Postgres.
const TAM_LOTE = 400;

async function gravar(Pg, itens) {
  const inicio = new Date();

  for (let i = 0; i < itens.length; i += TAM_LOTE) {
    const bloco = itens.slice(i, i + TAM_LOTE);
    const valores = [];
    const params = {};
    bloco.forEach((it, k) => {
      valores.push('(' + COLUNAS.map(c => '@' + c + k).join(', ') + ', NOW())');
      COLUNAS.forEach(c => { params[c + k] = it[c] === undefined ? null : it[c]; });
    });

    await Pg.connectAndQuery(
      `INSERT INTO tab_portal_espelho (${COLUNAS.join(', ')}, atualizado_em)
       VALUES ${valores.join(', ')}
       ON CONFLICT (ref) DO UPDATE SET
         cliente_nome = EXCLUDED.cliente_nome,
         contato_telefone = EXCLUDED.contato_telefone, contato_email = EXCLUDED.contato_email,
         vencimento = EXCLUDED.vencimento, valor = EXCLUDED.valor, saldo = EXCLUDED.saldo,
         situacao = EXCLUDED.situacao, data_pagamento = EXCLUDED.data_pagamento,
         valor_pago = EXCLUDED.valor_pago, tem_boleto = EXCLUDED.tem_boleto, banco = EXCLUDED.banco,
         nosso_numero = EXCLUDED.nosso_numero, linha_digitavel = EXCLUDED.linha_digitavel,
         codigo_barras = EXCLUDED.codigo_barras, pode_2via = EXCLUDED.pode_2via,
         motivo_2via = EXCLUDED.motivo_2via, atualizado_em = NOW(),
         -- mudou o que o cliente vê: precisa ir de novo para o portal
         publicado_em = CASE WHEN tab_portal_espelho.saldo <> EXCLUDED.saldo
                               OR tab_portal_espelho.situacao <> EXCLUDED.situacao
                               OR COALESCE(tab_portal_espelho.linha_digitavel, '') <> COALESCE(EXCLUDED.linha_digitavel, '')
                             THEN NULL ELSE tab_portal_espelho.publicado_em END,
         -- Mudou a linha digitável: o PDF que está no portal virou papel velho.
         pdf_em = CASE WHEN COALESCE(tab_portal_espelho.linha_digitavel, '') <> COALESCE(EXCLUDED.linha_digitavel, '')
                         OR NOT EXCLUDED.pode_2via
                       THEN NULL ELSE tab_portal_espelho.pdf_em END`,
      params);
  }

  // O que não foi tocado nesta rodada saiu do escopo (pago há mais de 12 meses,
  // título cancelado) — sai do espelho e some do portal na próxima publicação.
  // Comparar pelo carimbo é mais barato que mandar 40 mil chaves de volta.
  const fora = await Pg.connectAndQuery(
    'DELETE FROM tab_portal_espelho WHERE atualizado_em < @inicio RETURNING 1', { inicio });
  return { removidos: fora.length };
}

// ---------------------------------------------------------------- publicação

// Quantos PDFs cada rodada gera. Cada um custa duas consultas ao Protheus mais o
// render; fazer os ~400 de uma vez seguraria a publicação por minutos. O que
// sobra vai na rodada seguinte — `pdf_em IS NULL` é a fila.
const PDFS_POR_RODADA = Number(process.env.PORTAL_PDFS_POR_RODADA) || 120;

// O cliente precisa baixar o boleto, e o portal não pode pedir nada à intranet.
// Então o PDF viaja no espelho, em base64, só para quem tem 2ª via liberada.
async function anexarPdfs(app) {
  const { Pg } = app.services;
  const BoletoDocumento = require('./boletoDocumento');

  const alvos = await Pg.connectAndQuery(
    `SELECT e.id, e.ref,
            (SELECT MAX(r.id)
               FROM tab_boleto_envio_lote_retorno r
              WHERE COALESCE(r.prefixo, '') = COALESCE(e.prefixo, '')
                AND r.numero = e.numero
                AND COALESCE(r.parcela, '') = COALESCE(e.parcela, '')
                AND r.cliente_cod = e.cliente_cod AND r.cliente_loja = e.cliente_loja
                AND COALESCE(r.nosso_numero, '') <> ''
                AND r.status_banco = 'REGISTRADO') AS retorno_id
       FROM tab_portal_espelho e
      WHERE e.pode_2via AND e.pdf_em IS NULL
      ORDER BY e.vencimento
      LIMIT @lim`, { lim: PDFS_POR_RODADA });

  const pdfs = new Map();   // ref -> base64
  const ids = [];           // ids do espelho que ficam com pdf_em preenchido
  let falhas = 0;

  for (const a of alvos) {
    if (!a.retorno_id) {
      // Tem 2ª via liberada mas não achamos o registro do banco: nada a gerar.
      // Marcar evita tentar de novo a cada rodada; se o boleto for registrado
      // depois, a linha digitável muda e o `pdf_em` volta a NULL.
      ids.push(a.id);
      falhas++;
      continue;
    }
    try {
      const r = await BoletoDocumento.gerar(app, a.retorno_id);
      if (r.ok) {
        pdfs.set(a.ref, r.pdf.toString('base64'));
        ids.push(a.id);
      } else {
        ids.push(a.id);
        falhas++;
        console.warn(`portalEspelho: PDF de ${a.ref} recusado — ${r.body?.message || r.status}`);
      }
    } catch (e) {
      falhas++;   // sem marcar: erro de infra merece nova tentativa
      console.warn(`portalEspelho: PDF de ${a.ref} falhou — ${e.message}`);
    }
  }
  return { pdfs, ids, falhas };
}

async function publicar(app) {
  const { Pg } = app.services;
  const destino = trim(process.env.PORTAL_URL);
  const token = trim(process.env.PORTAL_TOKEN);
  if (!destino || !token) return { status: 'inerte', enviados: 0, destino: null };

  const pendentes = await Pg.connectAndQuery(
    `SELECT * FROM tab_portal_espelho WHERE publicado_em IS NULL ORDER BY id LIMIT 5000`, {});

  const { pdfs, ids: idsPdf, falhas: pdfFalhas } = await anexarPdfs(app);

  // Um título pode estar nas duas listas (mudou e ainda deve PDF). Junta por ref
  // para não mandar a mesma linha duas vezes.
  const porRef = new Map(pendentes.map(p => [p.ref, p]));
  if (pdfs.size) {
    const faltantes = [...pdfs.keys()].filter(ref => !porRef.has(ref));
    if (faltantes.length) {
      const extras = await Pg.connectAndQuery(
        `SELECT * FROM tab_portal_espelho WHERE ref = ANY(@refs::text[])`, { refs: faltantes });
      extras.forEach(e => porRef.set(e.ref, e));
    }
  }
  const itens = [...porRef.values()].map(i => {
    const pdf = pdfs.get(i.ref);
    return pdf ? { ...i, boleto_pdf: pdf } : i;
  });

  // Pedidos do portal que já entraram na fila do financeiro e ainda não foram
  // confirmados a ele. Sem isso o portal reenviaria o mesmo pedido para sempre.
  const aConfirmar = await Pg.connectAndQuery(
    `SELECT origem_id FROM tab_boleto_2via_solicitacao
      WHERE origem = 'portal' AND origem_id IS NOT NULL AND confirmado_em IS NULL
      LIMIT 500`, {});
  const confirmados = aConfirmar.map(c => trim(c.origem_id)).filter(Boolean);

  // Publica mesmo sem nada novo: é nesta resposta que os pedidos do cliente
  // chegam, e num dia sem movimento eles ficariam parados no portal.
  const pix = await pixPendentes(Pg);
  const corpo = await postar(destino, token, { itens, confirmados, pix });

  const ids = pendentes.map(p => p.id);
  if (ids.length) {
    await Pg.connectAndQuery(
      `UPDATE tab_portal_espelho SET publicado_em = NOW() WHERE id = ANY(@ids::int[])`, { ids });
  }
  if (idsPdf.length) {
    await Pg.connectAndQuery(
      `UPDATE tab_portal_espelho SET pdf_em = NOW() WHERE id = ANY(@ids::int[])`, { ids: idsPdf });
  }
  if (confirmados.length) {
    await Pg.connectAndQuery(
      `UPDATE tab_boleto_2via_solicitacao SET confirmado_em = NOW()
        WHERE origem_id = ANY(@ids::text[])`, { ids: confirmados });
  }
  await marcarPixPublicado(Pg, pix);

  // A conexão é sempre iniciada daqui, então o que o cliente fez no portal volta
  // NA RESPOSTA desta publicação — assim não precisamos abrir uma porta da
  // internet para a intranet.
  const recebidas = await ingerirSolicitacoes(Pg, corpo.solicitacoes);
  const pixCriados = await ingerirPixPedidos(app, corpo.pix_pedidos);

  return {
    status: 'enviado',
    enviados: ids.length,
    pdfs_enviados: pdfs.size,
    pdfs_sem_boleto: pdfFalhas,
    confirmados: confirmados.length,
    pix_enviados: pix.length,
    pix_pedidos: pixCriados,
    destino,
    solicitacoes_recebidas: recebidas
  };
}

// ------------------------------------------------------------------ Pix
// O POST ao portal, num lugar só: a publicação completa e a passada curta do
// Pix mandam coisas diferentes pela mesma porta.
async function postar(destino, token, dados) {
  const resp = await fetch(`${destino.replace(/\/+$/, '')}/espelho`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ geradoEm: new Date().toISOString(), ...dados })
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`portal respondeu ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return (await resp.json().catch(() => ({}))) || {};
}

// Cobranças cujo estado o portal ainda não conhece: QR recém-criado, Pix que
// caiu, cobrança que expirou ou deu erro.
async function pixPendentes(Pg) {
  const r = await Pg.connectAndQuery(
    `SELECT txid, ref, origem_id, status, copia_e_cola, qr_png, location,
            valor_original, vencimento, expira_em, valor_pago, pago_em, e2eid, erro,
            multa_perc, juros_perc
       FROM tab_pix_cobranca WHERE publicado_em IS NULL ORDER BY id LIMIT 200`, {});
  return r;
}

async function marcarPixPublicado(Pg, pix) {
  if (!pix || !pix.length) return;
  await Pg.connectAndQuery(
    `UPDATE tab_pix_cobranca SET publicado_em = NOW() WHERE txid = ANY(@ids::text[])`,
    { ids: pix.map(p => p.txid) });
}

// "Quero pagar por Pix" vindo do portal. A cobrança nasce aqui, com a
// credencial do banco, e o QR volta na passada seguinte.
async function ingerirPixPedidos(app, lista) {
  if (!Array.isArray(lista) || !lista.length) return 0;
  const Pix = require('./pixCobranca');
  let criadas = 0;
  for (const p of lista) {
    try {
      const r = await Pix.criar(app, { ref: trim(p.ref), origem: 'portal', origemId: trim(p.id) });
      if (r.cobranca && !r.jaExistia) criadas++;
      if (r.erro) console.warn(`portalEspelho: Pix de ${trim(p.ref)} recusado — ${r.erro}`);
    } catch (e) {
      console.warn(`portalEspelho: Pix de ${trim(p && p.ref)} falhou —`, e.message);
    }
  }
  return criadas;
}

// Passada CURTA, só para o Pix: leva o que mudou, traz os pedidos, cria as
// cobranças e leva o QR recém-criado na mesma chamada seguinte. É o que faz o
// cliente esperar segundos em vez do ciclo completo do espelho.
async function publicarPix(app) {
  const { Pg } = app.services;
  const destino = trim(process.env.PORTAL_URL);
  const token = trim(process.env.PORTAL_TOKEN);
  if (!destino || !token) return { status: 'inerte' };

  const pix = await pixPendentes(Pg);
  const corpo = await postar(destino, token, { itens: [], pix });
  await marcarPixPublicado(Pg, pix);

  const criadas = await ingerirPixPedidos(app, corpo.pix_pedidos);
  let entregues = 0;
  if (criadas) {
    // Segunda passada imediata: o QR que acabou de nascer vai agora, e não
    // daqui a meio minuto com o cliente olhando para a tela.
    const novos = await pixPendentes(Pg);
    if (novos.length) {
      await postar(destino, token, { itens: [], pix: novos });
      await marcarPixPublicado(Pg, novos);
      entregues = novos.length;
    }
  }
  // Pedidos de 2ª via também voltam nesta resposta — ignorar seria deixá-los
  // esperando o ciclo longo sem motivo.
  const recebidas = await ingerirSolicitacoes(Pg, corpo.solicitacoes);
  return { status: 'ok', pix_enviados: pix.length, pix_criados: criadas, pix_entregues: entregues, solicitacoes_recebidas: recebidas };
}

// Pedidos de 2ª via vindos do portal. Idempotente pelo id de lá: a mesma
// resposta chegando duas vezes não vira dois pedidos na fila do financeiro.
async function ingerirSolicitacoes(Pg, lista) {
  if (!Array.isArray(lista) || !lista.length) return 0;
  const Via = require('./boleto2Via');
  let criadas = 0;
  for (const s of lista) {
    try {
      const r = await Via.criar(Pg, {
        origem: 'portal',
        origem_id: trim(s.id) || null,
        ref: trim(s.ref),
        contato: trim(s.contato),
        mensagem: trim(s.mensagem)
      });
      if (r.solicitacao && !r.jaExistia) criadas++;
      if (r.erro) console.warn(`portalEspelho: pedido ${trim(s.id)} recusado — ${r.erro}`);
    } catch (e) {
      console.warn(`portalEspelho: pedido ${trim(s && s.id)} falhou —`, e.message);
    }
  }
  return criadas;
}

// ---------------------------------------------------------------- orquestração
async function rodar(app, { por } = {}) {
  const { Pg } = app.services;
  const t0 = Date.now();
  let pub = { status: 'gerado', enviados: 0, destino: null }, erro = null;
  let resumo = { titulos: 0, clientes: 0, com_boleto: 0, com_2via: 0, descartados_sem_documento: 0 };

  try {
    const m = await montar(app);
    resumo = m.resumo;
    await gravar(Pg, m.itens);
    pub = await publicar(app);
  } catch (e) {
    erro = e.message;
    pub.status = 'erro';
    console.error('portalEspelho:', e.message);
  }

  await Pg.connectAndQuery(
    `INSERT INTO tab_portal_publicacao
      (titulos, clientes, com_boleto, enviados, status, destino, erro, duracao_ms, por)
     VALUES (@titulos, @clientes, @com_boleto, @enviados, @status, @destino, @erro, @ms, @por)`,
    {
      titulos: resumo.titulos, clientes: resumo.clientes, com_boleto: resumo.com_boleto,
      enviados: pub.enviados, status: pub.status, destino: pub.destino, erro,
      ms: Date.now() - t0, por: por || null
    });

  return { ...resumo, ...pub, erro, duracao_ms: Date.now() - t0 };
}

module.exports = { montar, gravar, publicar, publicarPix, rodar, telefoneDe, emailDe, ingerirSolicitacoes };

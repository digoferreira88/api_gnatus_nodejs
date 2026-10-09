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
                             THEN NULL ELSE tab_portal_espelho.publicado_em END`,
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
async function publicar(Pg) {
  const destino = trim(process.env.PORTAL_URL);
  const token = trim(process.env.PORTAL_TOKEN);
  if (!destino || !token) return { status: 'inerte', enviados: 0, destino: null };

  const pendentes = await Pg.connectAndQuery(
    `SELECT * FROM tab_portal_espelho WHERE publicado_em IS NULL ORDER BY id LIMIT 5000`, {});
  if (!pendentes.length) return { status: 'enviado', enviados: 0, destino };

  const resp = await fetch(`${destino.replace(/\/+$/, '')}/espelho`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ geradoEm: new Date().toISOString(), itens: pendentes })
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`portal respondeu ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const ids = pendentes.map(p => p.id);
  await Pg.connectAndQuery(
    `UPDATE tab_portal_espelho SET publicado_em = NOW() WHERE id = ANY(@ids::int[])`, { ids });
  return { status: 'enviado', enviados: ids.length, destino };
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
    pub = await publicar(Pg);
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

module.exports = { montar, gravar, publicar, rodar, telefoneDe, emailDe };

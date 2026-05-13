// Script de validacao do endpoint REST SolicCompra/incluir (WSRESTFUL custom Develsoft)
//
// Roda 10 cenarios contra o endpoint e imprime PASS/FAIL pra cada um.
// Uso: `node test-solic-compra-incluir.js [url] [user] [pass] [produtoReal] [ccReal]`
//      default url:  http://protheus.gnatus.com.br:8081/rest/SolicCompra/incluir
//              auth: admin:Gn@tu5
//
// IMPORTANTE: o cenario 10 (payload valido) PRECISA de codigo de produto
// e centro de custo REAIS pra criar a SC com sucesso. Passe via argv:
//   node test-solic-compra-incluir.js '' '' '' MEU_PRODUTO MEU_CC
//
// Pre-requisito: Node 18+ (usa fetch nativo).
//
// Formato do response (padrao MIT072 TOTVS):
//   sucesso -> 200 { STATUS:{TOTAL,ATUALIZADOS,NAO_ATUALIZADOS,DURACAO}, INCONSISTENCIAS:[], SC_GERADAS:["099823"] }
//   erro de validacao -> 400 { codigo_erro:"...", mensagem:"..." }
//   erro item -> 200 { STATUS:{...,NAO_ATUALIZADOS:N}, INCONSISTENCIAS:[{linha,campo,mensagem}], SC_GERADAS:[] }

const URL_DEFAULT = 'http://protheus.gnatus.com.br:8081/rest/SolicCompra/incluir';
const url  = process.argv[2] || URL_DEFAULT;
const user = process.argv[3] || 'admin';
const pass = process.argv[4] || 'Gn@tu5';
const produtoReal = process.argv[5] || 'PRODUTO_REAL_1';
const ccReal      = process.argv[6] || 'CC_REAL';

const authValido = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const authInvalido = 'Basic ' + Buffer.from('wrong:credentials').toString('base64');

const itemMin = (p, q) => ({
  produto: p, quantidade: q, local: '01', centro_custo: ccReal,
  observacao: 'Item de teste'
});

const bodyValido = {
  filial: '01',
  solicitante: 'INTRANET',
  data_emissao: '20260513',
  data_necessaria: '20260520',
  observacao: 'Teste automatizado test-solic-compra-incluir',
  itens: [itemMin(produtoReal, 1)]
};

// `validar` recebe (status, json, text) e devolve { ok: bool, msg?: string }
const tests = [
  // Auth — 401 generico do AppServer (igual no bordero)
  {
    nome: '01) Sem Authorization',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyValido),
    validar: (s) => ({ ok: s === 401, msg: `HTTP esperado 401, recebido ${s}` })
  },
  {
    nome: '02) Basic Auth errado',
    headers: { 'Content-Type': 'application/json', Authorization: authInvalido },
    body: JSON.stringify(bodyValido),
    validar: (s) => ({ ok: s === 401, msg: `HTTP esperado 401, recebido ${s}` })
  },
  // Validacoes de campo (pre-AdvPL) — esperamos 400 com codigo_erro
  // Validacoes de campo — Develsoft padronizou em INCONSISTENCIAS[] em vez
  // de codigo_erro no root (mais consistente com o formato MIT072 — TODO erro
  // vai pro mesmo array, validacao ou item).
  {
    nome: '03) Body vazio',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: '',
    validar: (s, j) => ({
      ok: s === 400 && j?.INCONSISTENCIAS?.[0]?.codigo_erro === 'BODY_INVALIDO',
      msg: `400 + INCONSISTENCIAS[0].codigo_erro=BODY_INVALIDO, veio ${s} ${j?.INCONSISTENCIAS?.[0]?.codigo_erro || '(vazio)'}`
    })
  },
  {
    nome: '04) JSON invalido',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: '{filial:"01",sem_aspas}',
    validar: (s, j) => ({
      ok: s === 400 && j?.INCONSISTENCIAS?.[0]?.codigo_erro === 'JSON_INVALIDO',
      msg: `400 + INCONSISTENCIAS[0].codigo_erro=JSON_INVALIDO, veio ${s} ${j?.INCONSISTENCIAS?.[0]?.codigo_erro || '(vazio)'}`
    })
  },
  {
    nome: '05) Sem filial',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({ solicitante: 'INTRANET', itens: [itemMin(produtoReal, 1)] }),
    validar: (s, j) => ({
      ok: s === 400 && j?.INCONSISTENCIAS?.[0]?.codigo_erro === 'FILIAL_OBRIGATORIA',
      msg: `400 + INCONSISTENCIAS[0].codigo_erro=FILIAL_OBRIGATORIA, veio ${s} ${j?.INCONSISTENCIAS?.[0]?.codigo_erro || '(vazio)'}`
    })
  },
  {
    nome: '06) Sem solicitante',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({ filial: '01', itens: [itemMin(produtoReal, 1)] }),
    validar: (s, j) => ({
      ok: s === 400 && j?.INCONSISTENCIAS?.[0]?.codigo_erro === 'SOLICITANTE_OBRIGATORIO',
      msg: `400 + INCONSISTENCIAS[0].codigo_erro=SOLICITANTE_OBRIGATORIO, veio ${s} ${j?.INCONSISTENCIAS?.[0]?.codigo_erro || '(vazio)'}`
    })
  },
  {
    nome: '07) itens array vazio',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({ filial: '01', solicitante: 'INTRANET', itens: [] }),
    validar: (s, j) => ({
      ok: s === 400 && j?.INCONSISTENCIAS?.[0]?.codigo_erro === 'SEM_ITENS',
      msg: `400 + INCONSISTENCIAS[0].codigo_erro=SEM_ITENS, veio ${s} ${j?.INCONSISTENCIAS?.[0]?.codigo_erro || '(vazio)'}`
    })
  },
  // Erros de item — esperamos 200 + INCONSISTENCIAS preenchido
  {
    nome: '08) Item com produto inexistente (espera INCONSISTENCIA)',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({
      ...bodyValido,
      itens: [itemMin('PRODUTO_FAKE_XXX_999', 1)]
    }),
    validar: (s, j) => ({
      ok: s === 200 && Array.isArray(j?.INCONSISTENCIAS) && j.INCONSISTENCIAS.length > 0 && (j?.SC_GERADAS?.length || 0) === 0,
      msg: `200 + INCONSISTENCIAS>0 + SC_GERADAS=[] esperado, veio ${s} ATU=${j?.STATUS?.ATUALIZADOS} INC=${j?.INCONSISTENCIAS?.length} SC=${j?.SC_GERADAS?.length || 0}`
    })
  },
  {
    nome: '09) Item com quantidade zero',
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify({
      ...bodyValido,
      itens: [{ produto: produtoReal, quantidade: 0, local: '01', centro_custo: ccReal }]
    }),
    validar: (s, j) => ({
      ok: s === 200 && j?.INCONSISTENCIAS?.[0]?.codigo_erro === 'QUANTIDADE_INVALIDA' && (j?.SC_GERADAS?.length || 0) === 0,
      msg: `200 + INCONSISTENCIAS[0].codigo_erro=QUANTIDADE_INVALIDA + SC_GERADAS=[], veio ${s} ${j?.INCONSISTENCIAS?.[0]?.codigo_erro || `INC=${j?.INCONSISTENCIAS?.length}`}`
    })
  },
  // Sucesso — tem que criar SC real (precisa de produto e CC reais)
  {
    nome: `10) Payload valido (produto=${produtoReal}, CC=${ccReal}) — espera SC criada`,
    headers: { 'Content-Type': 'application/json', Authorization: authValido },
    body: JSON.stringify(bodyValido),
    validar: (s, j) => ({
      ok: s === 200 && j?.STATUS?.ATUALIZADOS >= 1 && Array.isArray(j?.SC_GERADAS) && j.SC_GERADAS.length >= 1 && (j?.INCONSISTENCIAS?.length || 0) === 0,
      msg: `200 + ATUALIZADOS>=1 + SC_GERADAS preenchido + sem INCONSISTENCIAS, veio ${s} ATU=${j?.STATUS?.ATUALIZADOS} SC=${JSON.stringify(j?.SC_GERADAS)} INC=${j?.INCONSISTENCIAS?.length}`
    })
  }
];

(async () => {
  console.log(`Endpoint: ${url}`);
  console.log(`Auth: ${user}:${'*'.repeat(pass.length)}`);
  console.log(`Produto real: ${produtoReal} · CC real: ${ccReal}\n`);

  let nPass = 0, nFail = 0;
  for (const t of tests) {
    try {
      const r = await fetch(url, { method: 'POST', headers: t.headers, body: t.body });
      const txt = await r.text();
      let json = null;
      try { json = JSON.parse(txt); } catch {}

      const v = t.validar(r.status, json, txt);
      const icon = v.ok ? '✓ PASS' : '✗ FAIL';
      console.log(`${icon}  ${t.nome}`);
      if (!v.ok) console.log(`        ${v.msg}`);
      if (json?.SC_GERADAS?.length) console.log(`        SC criada: ${json.SC_GERADAS.join(', ')}`);
      if (json?.STATUS) console.log(`        STATUS: ATU=${json.STATUS.ATUALIZADOS} NAO=${json.STATUS.NAO_ATUALIZADOS} DURACAO=${json.STATUS.DURACAO}`);
      if (json?.INCONSISTENCIAS?.length) {
        console.log(`        INCONSISTENCIAS:`);
        json.INCONSISTENCIAS.slice(0, 3).forEach(i => console.log(`          ${JSON.stringify(i).slice(0, 200)}`));
      }
      if (!v.ok && !json) console.log(`        body cru: ${txt.slice(0, 200)}`);
      console.log();

      if (v.ok) nPass++; else nFail++;
    } catch (err) {
      console.log(`✗ FAIL  ${t.nome}`);
      console.log(`        erro de rede/conexao: ${err.message}\n`);
      nFail++;
    }
  }
  console.log(`────────────────────────────────`);
  console.log(`Resultado: ${nPass} PASS · ${nFail} FAIL · total ${tests.length}`);
  process.exit(nFail > 0 ? 1 : 0);
})();

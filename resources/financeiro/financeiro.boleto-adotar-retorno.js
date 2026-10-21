// POST /financeiro/boleto-adotar-retorno
// Body: { conteudo_base64, banco, agencia, conta, simular? }
//
// Registra titulos a partir do ARQUIVO DE RETORNO (.RET) — caminho 100%
// intranet, SEM depender do Diego gravar no Protheus. Serve ao Santander (033)
// e aos portadores de CESSAO (044 Acreditar, 699 Grupo BFC).
//
// Contexto: o importar-retorno do Diego nao casava o titulo Santander (procurava
// por E1_NUMBCO, vazio). Mas o NOSSO NUMERO atribuido pelo banco ESTA no .RET, e
// a intranet calcula a linha digitavel localmente. Entao lemos o nosso numero do
// arquivo e gravamos na propria base -> o boleto fica disparavel.
//
// Nos portadores de cessao, alem disso, o nosso numero que vale e' o que o
// FUNDO registrou no banco, que pode nao ser o E1_NUMBCO (no BFC a SE1 tem a
// faixa 00006630xxx do Protheus e o fundo registrou 99111230xxx). Este e' o
// unico caminho que grava o nosso numero desses portadores na intranet.
//
// Como a linha do .RET vira titulo:
//   - uso da empresa (038-062) preenchido -> chave direto dele (Santander, Acreditar);
//   - uso da empresa EM BRANCO (Grupo BFC) -> pelo SEU NUMERO "92276-3" contra a
//     SE1 do portador. So aceita candidato UNICO com valor e vencimento iguais
//     aos do arquivo; o resto volta em `nao_identificados`, sem adivinhar.
//
// Destino de cada titulo identificado:
//   1. ja tem linha de retorno num lote -> atualiza (REGISTRADO + nosso numero);
//   2. esta num lote, mas ainda sem linha de retorno (lote nunca sincronizado)
//      -> cria a linha de retorno nesse lote;
//   3. nao esta em lote nenhum -> cessao: cria lote retroativo (como o
//      adotar-SE1); Santander: lista como orfao (comportamento de sempre).
//
// simular:true (default) -> so mostra o que SERIA feito, nao grava.
// Permissao 8005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const Auditoria = require('../../services/auditoria');
const Cnab = require('../../services/cnabRetornoFiltro');
const PortadorCessao = require('../../services/portadorCessao');
const BoletoAdotar = require('../../services/boletoAdotar');

const trim = (v) => String(v || '').trim();
const centavos = (v) => Math.round(Number(v || 0) * 100);
const semZeros = (v) => trim(v).replace(/^0+(?=\d)/, '');
const ddmmaaParaIso = (s) => (/^\d{6}$/.test(String(s || ''))
  ? `20${s.slice(4, 6)}${s.slice(2, 4)}${s.slice(0, 2)}` : '');
const chaveDe = (t) => `${trim(t.prefixo)}|${trim(t.numero)}|${trim(t.parcela)}`;

// Lotes cujo titulo ja passou pelo Protheus (borderô gerado).
const LOTE_ENVIADO = ['ENVIADO_PROTHEUS', 'RETORNADO', 'DISPARADO'];

// Borderôs de TESTE — títulos que existem na SE1 mas cujos boletos NÃO serão
// honrados (homologação com o FIDC). São IGNORADOS aqui pra que um retorno de
// teste importado por engano não os torne "registrados" e, pior, disparáveis ao
// cliente real. Ex.: borderô 001514 (teste Acreditar FIDC, 11/08/2026 — os 6
// títulos serão zerados no Protheus antes da produção).
// Configurável: BOLETO_BORDEROS_TESTE=001514,001520
const BORDEROS_TESTE = () => new Set(
  String(process.env.BOLETO_BORDEROS_TESTE || '001514')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

/**
 * Resolve na SE1, pelo SEU NUMERO, as linhas cujo uso da empresa veio em branco
 * (retorno do Grupo BFC). Procura so no portador; exige candidato UNICO e
 * valor + vencimento iguais aos do arquivo.
 *
 * Medido no 1o retorno real (30/09/2026, 363 linhas): 303 com 1 candidato,
 * 60 com 2 (o 2o em outro portador — o filtro do portador resolve), valor e
 * vencimento conferindo em todas.
 *
 * Devolve um item por linha, na mesma ordem:
 *   { ok:true, chave:{prefixo,numero,parcela} }
 *   { ok:false, motivo: SEU_NUMERO_INVALIDO | NAO_LOCALIZADO | AMBIGUO |
 *                       VALOR_DIVERGENTE | VENCIMENTO_DIVERGENTE, ... }
 */
async function resolverPeloSeuNumero(Protheus, linhas, portador) {
  const alvo = linhas.map((d) => ({ d, k: Cnab.chaveDoSeuNumero(d.seuNumero) }));
  // E1_NUM costuma ter 6 posicoes com zero a esquerda ("092276"); o arquivo
  // vem sem o zero ("92276"). Procura as duas formas.
  const nums = [...new Set(alvo.filter((a) => a.k).flatMap((a) => [a.k.numero, a.k.numero.padStart(6, '0')]))];
  const se = [];
  const BATCH = 400;
  for (let i = 0; i < nums.length; i += BATCH) {
    const slice = nums.slice(i, i + BATCH);
    const p = { port: portador };
    slice.forEach((n, j) => { p[`n${j}`] = n; });
    const rows = await Protheus.connectAndQuery(`
      SELECT RTRIM(E1_PREFIXO) prefixo, RTRIM(E1_NUM) numero, RTRIM(E1_PARCELA) parcela,
             E1_VALOR valor, RTRIM(E1_VENCTO) vencto, RTRIM(E1_VENCREA) vencrea
        FROM SE1010 WITH (NOLOCK)
       WHERE D_E_L_E_T_<>'*' AND E1_FILIAL='01' AND RTRIM(E1_PORTADO)=@port
         AND RTRIM(E1_TIPO) NOT IN ('RA','NCC')
         AND RTRIM(E1_NUM) IN (${slice.map((_, j) => `@n${j}`).join(',')})`, p);
    se.push(...rows);
  }

  return alvo.map(({ d, k }) => {
    const base = { seuNumero: trim(d.seuNumero), nossoNumero: d.nossoNumero, valor: d.valor };
    if (!k) return { ...base, ok: false, motivo: 'SEU_NUMERO_INVALIDO' };
    const c = se.filter((x) => semZeros(x.numero) === k.numero && semZeros(x.parcela) === k.parcela);
    if (!c.length) return { ...base, ok: false, motivo: 'NAO_LOCALIZADO' };
    if (c.length > 1) {
      return { ...base, ok: false, motivo: 'AMBIGUO', candidatos: c.map((x) => [x.prefixo, x.numero, x.parcela].filter(Boolean).join('/')) };
    }
    const x = c[0];
    const titulo = [x.prefixo, x.numero, x.parcela].filter(Boolean).join('/');
    if (centavos(x.valor) !== centavos(d.valor)) {
      return { ...base, ok: false, motivo: 'VALOR_DIVERGENTE', titulo, valorSe1: Number(x.valor) };
    }
    const venc = ddmmaaParaIso(d.vencimento);
    if (venc && venc !== trim(x.vencto) && venc !== trim(x.vencrea)) {
      return { ...base, ok: false, motivo: 'VENCIMENTO_DIVERGENTE', titulo, vencimento: venc, vencimentoSe1: trim(x.vencto) };
    }
    return { ...base, ok: true, chave: { prefixo: x.prefixo, numero: x.numero, parcela: x.parcela } };
  });
}

module.exports = (app) => ({
  verb: 'post',
  route: '/boleto-adotar-retorno',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    const conteudoBase64 = trim(req.body?.conteudo_base64);
    const banco = trim(req.body?.banco) || '033';
    const simular = req.body?.simular !== false;

    if (!conteudoBase64) return res.status(400).json({ message: 'Envie o conteudo do arquivo (.RET) em conteudo_base64.' });

    // Portador de CESSÃO (FIDC): o layout do .RET é o do BANCO LIQUIDANTE
    // (ex.: portador 044 Acreditar -> retorno Bradesco 237), não o do portador.
    const cessao = PortadorCessao.get(banco);
    const bancoLayout = cessao ? cessao.bancoBoleto : banco;
    if (banco !== '033' && !cessao) {
      return res.status(400).json({ message: `Banco ${banco} não suportado neste fluxo (hoje: 033 Santander e portadores de cessão ${PortadorCessao.codigos().join('/')}).` });
    }

    try {
      const texto = Buffer.from(conteudoBase64, 'base64').toString('latin1');
      const detalhes = Cnab.parseDetalhesPorBanco(texto, bancoLayout);
      // Entrada confirmada (02) com nosso numero atribuido. O NN tem largura
      // diferente por banco (8 Santander, 11 Bradesco) — testa "só zeros".
      const confirmados = detalhes.filter(d =>
        d.ocorrencia === '02' && d.nossoNumero && !/^0+$/.test(d.nossoNumero));
      if (!confirmados.length) {
        return res.json({ ok: true, atualizados: 0, candidatos: 0, mensagem: 'Nenhuma entrada confirmada (02) com nosso numero no arquivo.' });
      }

      // ----- Chave de cada linha -----
      const identificados = confirmados.filter(d => trim(d.numero));
      const semUso = confirmados.filter(d => !trim(d.numero));
      const naoIdentificados = [];
      let criterio = 'uso_empresa';
      if (semUso.length) {
        if (!cessao) {
          semUso.forEach(d => naoIdentificados.push({ ok: false, motivo: 'SEM_CHAVE', seuNumero: trim(d.seuNumero), nossoNumero: d.nossoNumero, valor: d.valor }));
        } else {
          criterio = identificados.length ? 'uso_empresa+seu_numero' : 'seu_numero';
          const r = await resolverPeloSeuNumero(Protheus, semUso, banco);
          r.forEach((x, i) => {
            if (x.ok) identificados.push({ ...semUso[i], ...x.chave });
            else naoIdentificados.push(x);
          });
        }
      }

      // mapa chave (prefixo|numero|parcela) -> nosso numero
      const nossoPorChave = new Map();
      identificados.forEach(d => nossoPorChave.set(chaveDe(d), d.nossoNumero));
      // Data da ocorrencia (entrada confirmada) por chave, YYYYMMDD. No BFC vira
      // a data do documento/processamento do boleto (igual a ficha do fundo).
      const dataPorChave = new Map();
      identificados.forEach(d => { const iso = ddmmaaParaIso(d.dataOcorrencia); if (iso) dataPorChave.set(chaveDe(d), iso); });

      // Guard (titulo ja baixado) + borderô (E1_NUMBOR) + dados do titulo, por
      // chave. O borderô vai pro tab_boleto_envio_lote_retorno.bordero_protheus
      // pra a tela de Disparar poder filtrar por borderô. RA/NCC ficam fora: um
      // adiantamento baixado com o mesmo numero/parcela nao pode fazer a NF
      // parecer baixada.
      const baixados = new Set();
      const numborPorChave = new Map();
      const se1PorChave = new Map();     // so quando ha exatamente 1 titulo na chave
      const se1Contagem = new Map();
      const keys = [...nossoPorChave.keys()];
      const BATCH = 80;
      for (let b = 0; b < keys.length; b += BATCH) {
        const slice = keys.slice(b, b + BATCH); const p = {};
        const ors = slice.map((k, j) => { const [pf, nu, pa] = k.split('|'); p[`pf${j}`]=pf;p[`nu${j}`]=nu;p[`pa${j}`]=pa;
          return `(RTRIM(E1_PREFIXO)=@pf${j} AND RTRIM(E1_NUM)=@nu${j} AND RTRIM(E1_PARCELA)=@pa${j})`; }).join(' OR ');
        const rows = await Protheus.connectAndQuery(`
          SELECT RTRIM(E1_PREFIXO) prefixo, RTRIM(E1_NUM) numero, RTRIM(E1_PARCELA) parcela,
                 RTRIM(E1_STATUS) status, RTRIM(E1_BAIXA) baixa, RTRIM(E1_NUMBOR) numbor,
                 RTRIM(E1_TIPO) tipo, RTRIM(E1_CLIENTE) cliente_cod, RTRIM(E1_LOJA) cliente_loja,
                 RTRIM(E1_PORTADO) portador, RTRIM(E1_AGEDEP) agencia, RTRIM(E1_CONTA) conta,
                 E1_VALOR valor, E1_VENCREA vencimento
            FROM SE1010 WITH (NOLOCK)
           WHERE D_E_L_E_T_<>'*' AND E1_FILIAL='01' AND RTRIM(E1_TIPO) NOT IN ('RA','NCC') AND (${ors})`, p);
        rows.forEach(r => {
          const k = chaveDe(r);
          if (trim(r.status)==='B' || trim(r.baixa).length>=8) baixados.add(k);
          if (trim(r.numbor)) numborPorChave.set(k, trim(r.numbor));
          se1Contagem.set(k, (se1Contagem.get(k) || 0) + 1);
          se1PorChave.set(k, r);
        });
      }

      // Linhas de retorno existentes que casam com as chaves do .RET — só em
      // lotes DESTE banco. Um título que passou por dois bancos tem linha nos
      // lotes dos dois; o .RET do Santander não pode mexer na linha do Itaú.
      const existentes = [];
      for (let b = 0; b < keys.length; b += BATCH) {
        const slice = keys.slice(b, b + BATCH); const p = { banco };
        const ors = slice.map((k, i) => { const [pf, nu, pa] = k.split('|'); p[`pf${i}`]=pf;p[`nu${i}`]=nu;p[`pa${i}`]=pa;
          return `(COALESCE(TRIM(r.prefixo),'')=@pf${i} AND TRIM(r.numero)=@nu${i} AND COALESCE(TRIM(r.parcela),'')=@pa${i})`; }).join(' OR ');
        const rows = await Pg.connectAndQuery(`
          SELECT r.id, r.id_lote, COALESCE(TRIM(r.prefixo),'') prefixo, TRIM(r.numero) numero, COALESCE(TRIM(r.parcela),'') parcela,
                 r.status_banco, COALESCE(TRIM(r.nosso_numero),'') nosso_numero, COALESCE(TRIM(r.bordero_protheus),'') bordero_protheus,
                 COALESCE(TRIM(r.data_ocorrencia),'') data_ocorrencia
            FROM tab_boleto_envio_lote_retorno r
            JOIN tab_boleto_envio_lote l ON l.id = r.id_lote
           WHERE TRIM(l.banco_cod) = @banco AND (${ors})`, p);
        rows.forEach(r => existentes.push(r));
      }
      const existentesPorChave = new Map();
      existentes.forEach(r => {
        const k = chaveDe(r);
        if (!existentesPorChave.has(k)) existentesPorChave.set(k, []);
        existentesPorChave.get(k).push(r);
      });

      // Titulos em lote enviado ao Protheus, mas sem linha de retorno ainda
      // (lote nunca sincronizado). Prefere o lote do mesmo borderô.
      const semRetorno = keys.filter(k => !existentesPorChave.has(k));
      const lotePorChave = new Map();
      for (let b = 0; b < semRetorno.length; b += BATCH) {
        const slice = semRetorno.slice(b, b + BATCH); const p = { banco };
        const ors = slice.map((k, i) => { const [pf, nu, pa] = k.split('|'); p[`pf${i}`]=pf;p[`nu${i}`]=nu;p[`pa${i}`]=pa;
          return `(COALESCE(TRIM(t.prefixo),'')=@pf${i} AND TRIM(t.numero)=@nu${i} AND COALESCE(TRIM(t.parcela),'')=@pa${i})`; }).join(' OR ');
        const rows = await Pg.connectAndQuery(`
          SELECT t.id_lote, COALESCE(TRIM(t.prefixo),'') prefixo, TRIM(t.numero) numero, COALESCE(TRIM(t.parcela),'') parcela,
                 TRIM(t.cliente_cod) cliente_cod, TRIM(t.cliente_loja) cliente_loja,
                 COALESCE(TRIM(l.lote_protheus),'') lote_protheus
            FROM tab_boleto_envio_lote_titulo t
            JOIN tab_boleto_envio_lote l ON l.id = t.id_lote
           WHERE TRIM(l.banco_cod) = @banco AND l.status IN (${LOTE_ENVIADO.map(s => `'${s}'`).join(',')}) AND (${ors})
           ORDER BY t.id_lote DESC`, p);
        rows.forEach(r => {
          const k = chaveDe(r);
          const atual = lotePorChave.get(k);
          const doBordero = r.lote_protheus && r.lote_protheus === (numborPorChave.get(k) || '');
          if (!atual || (doBordero && !atual.doBordero)) lotePorChave.set(k, { ...r, doBordero });
        });
      }

      // Classifica.
      const aAtualizar = [];   // {id, id_lote, nosso, numbor}
      const aInserir = [];     // {id_lote, prefixo, numero, parcela, cliente_cod, cliente_loja, nosso, numbor}
      const aAdotar = [];      // linhas SE1 com numbco = nosso numero do .RET
      let jaOk = 0, baixadoSkip = 0, testeSkip = 0;
      const testes = BORDEROS_TESTE();
      const orfaos = [];
      const outroPortador = [];   // título que hoje está em outro banco no Protheus
      for (const [k, nosso] of nossoPorChave.entries()) {
        if (baixados.has(k)) { baixadoSkip++; continue; }
        // Saiu deste banco depois da remessa (transferido ou devolvido à
        // carteira): a entrada confirmada do .RET é de um registro que não vale
        // mais. Registrar aqui recriaria o problema do borderô 418817.
        const seAtual = se1PorChave.get(k);
        if (seAtual && trim(seAtual.portador) !== banco) {
          outroPortador.push(`${k.split('|').filter(Boolean).join('/')} → ${trim(seAtual.portador) || 'sem portador'}`);
          continue;
        }
        // Borderô de TESTE (boleto não será honrado) -> nunca registrar, senão
        // vira disparável e o cliente REAL recebe um boleto de homologação.
        if (testes.has(numborPorChave.get(k) || '')) { testeSkip++; continue; }
        const numbor = numborPorChave.get(k) || '';
        const rows = existentesPorChave.get(k);
        if (rows && rows.length) {
          // Cessão: o número do fundo prevalece sobre qualquer outro já gravado
          // (ex.: o E1_NUMBCO do Protheus que uma sincronização antiga trouxe).
          // Santander: só preenche quando está vazio, como sempre foi.
          const nnPendente = (r) => (cessao ? trim(r.nosso_numero) !== trim(nosso) : !trim(r.nosso_numero));
          // Cessão: completa a data da ocorrência das linhas registradas antes
          // dela existir (o PDF do BFC usa essa data).
          const dataPendente = (r) => cessao && !!dataPorChave.get(k) && !trim(r.data_ocorrencia);
          const pend = rows.find(r =>
            trim(r.status_banco) !== 'REGISTRADO' || nnPendente(r) || dataPendente(r) ||
            (numbor && !trim(r.bordero_protheus)));
          if (pend) aAtualizar.push({ id: pend.id, id_lote: pend.id_lote, nosso, numbor, dataOc: dataPorChave.get(k) || '' });
          else jaOk++;
          continue;
        }
        const lt = lotePorChave.get(k);
        if (lt) { aInserir.push({ ...lt, nosso, numbor, dataOc: dataPorChave.get(k) || '' }); continue; }
        // Fora de qualquer lote. Cessao: adota com o nosso numero do .RET, se a
        // SE1 tem UM titulo nessa chave (senao nao ha como saber cliente/loja).
        const se = se1PorChave.get(k);
        if (cessao && se && se1Contagem.get(k) === 1) aAdotar.push({ ...se, numbco: nosso, bordero: numbor, data_ocorrencia: dataPorChave.get(k) || '' });
        else orfaos.push(k);
      }

      const porMotivo = {};
      naoIdentificados.forEach(x => { porMotivo[x.motivo] = (porMotivo[x.motivo] || 0) + 1; });
      const resumo = {
        banco, banco_layout: bancoLayout, cessao: !!cessao,
        criterio,
        candidatos: confirmados.length,
        identificados: nossoPorChave.size,
        a_atualizar: aAtualizar.length,
        a_inserir: aInserir.length,          // em lote, sem linha de retorno ainda
        a_adotar: aAdotar.length,            // fora de lote (cessão): lote retroativo
        ja_registrados: jaOk,
        ja_baixados: baixadoSkip,
        ignorados_teste: testeSkip,     // borderô de homologação — não vira disparável
        outro_portador: outroPortador.length,
        outro_portador_lista: outroPortador.slice(0, 50),
        orfaos: orfaos.length,
        nao_identificados: naoIdentificados.length,
        nao_identificados_por_motivo: porMotivo,
        nao_identificados_lista: naoIdentificados.slice(0, 50)
      };
      const total = aAtualizar.length + aInserir.length + aAdotar.length;
      const destino = 'Ficam disparáveis em "Disparar boletos".';

      if (simular) {
        return res.json({ ok: true, simular: true, ...resumo,
          mensagem: `${total} título(s) seriam registrados com o nosso número do .RET. ${destino}`
            + (naoIdentificados.length ? ` ${naoIdentificados.length} linha(s) não identificada(s).` : '')
            + (outroPortador.length ? ` ${outroPortador.length} título(s) ignorado(s): hoje estão em outro banco no Protheus.` : '')
            + (orfaos.length ? ` ${orfaos.length} órfão(s) (não estão em lote).` : '') });
      }

      if (!total) {
        return res.json({ ok: true, simular: false, atualizados: 0, ...resumo, mensagem: 'Nada novo a registrar.' });
      }

      const lotesTocados = new Set();
      // (1) Backfill: seta nosso_numero + REGISTRADO nas linhas pendentes
      for (const u of aAtualizar) {
        await Pg.connectAndQuery(`
          UPDATE tab_boleto_envio_lote_retorno
             SET nosso_numero = @nn, status_banco = 'REGISTRADO',
                 ocorrencia_cod = '02', ocorrencia_desc = 'Entrada confirmada (.RET lido pela intranet)',
                 bordero_protheus = COALESCE(NULLIF(@bord, ''), bordero_protheus),
                 data_ocorrencia = COALESCE(NULLIF(@doc, ''), data_ocorrencia)
           WHERE id = @id`, { id: u.id, nn: u.nosso, bord: u.numbor || '', doc: u.dataOc || '' });
        lotesTocados.add(u.id_lote);
      }
      // (2) Titulo em lote, sem linha de retorno: cria a linha
      for (const t of aInserir) {
        await Pg.connectAndQuery(`
          INSERT INTO tab_boleto_envio_lote_retorno
            (id_lote, prefixo, numero, parcela, cliente_cod, cliente_loja,
             status_banco, ocorrencia_cod, ocorrencia_desc, nosso_numero, bordero_protheus,
             valor_liquidado, data_liquidacao, sincronizado_em, data_ocorrencia)
          VALUES (@id, @pre, @num, @par, @cli, @loja,
                  'REGISTRADO', '02', 'Entrada confirmada (.RET lido pela intranet)', @nn, @bord,
                  0, NULL, NOW(), NULLIF(@doc, ''))
          ON CONFLICT DO NOTHING`,
          { id: t.id_lote, pre: t.prefixo || null, num: t.numero, par: t.parcela || null,
            cli: t.cliente_cod, loja: t.cliente_loja, nn: t.nosso, bord: t.numbor || null, doc: t.dataOc || '' });
        lotesTocados.add(t.id_lote);
      }
      // Lote fica RETORNADO so quando TODOS os titulos dele tem linha de
      // retorno e nenhuma esta pendente — senao um lote parcialmente retornado
      // sumiria da fila. DISPARADO nunca volta para RETORNADO.
      for (const idLote of lotesTocados) {
        await Pg.connectAndQuery(`
          UPDATE tab_boleto_envio_lote
             SET status = CASE
                   WHEN status = 'ENVIADO_PROTHEUS'
                    AND NOT EXISTS (SELECT 1 FROM tab_boleto_envio_lote_retorno WHERE id_lote = @id AND status_banco = 'PENDENTE')
                    AND (SELECT COUNT(*) FROM tab_boleto_envio_lote_retorno WHERE id_lote = @id)
                        >= (SELECT COUNT(*) FROM tab_boleto_envio_lote_titulo WHERE id_lote = @id)
                   THEN 'RETORNADO' ELSE status END,
                 sincronizado_em = NOW(),
                 qt_registrados = (SELECT COUNT(*) FROM tab_boleto_envio_lote_retorno WHERE id_lote = @id AND status_banco = 'REGISTRADO')
           WHERE id = @id`,
          { id: idLote });
      }
      // (3) Cessao fora de lote: lote retroativo com o nosso numero do fundo
      let adocao = null;
      if (aAdotar.length) {
        adocao = await BoletoAdotar.criarLotesRetroativos({
          Pg, Protheus, user, titulos: aAdotar,
          rotulo: 'adotado .RET',
          ocorrenciaDesc: 'Entrada confirmada (.RET lido pela intranet)',
          observacao: `Lote retroativo criado pelo "Registrar pelo .RET" em ${new Date().toISOString()}: títulos do portador ${banco} registrados pelo fundo, sem lote na intranet. Nosso número = o do arquivo de retorno.`
        });
        (adocao.lotes || []).forEach(l => lotesTocados.add(l.id));
      }

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: 'ADOTAR_RETORNO', severidade: 'CRITICO', req,
        entidade: 'lote', entidadeId: [...lotesTocados].join(','),
        descricao: `Registrou ${total} título(s) do portador ${banco} pelo nosso número do .RET (sem Protheus)`
          + ` — ${aAtualizar.length} atualizado(s), ${aInserir.length} em lote sem retorno, ${aAdotar.length} adotado(s) em lote novo`
          + (naoIdentificados.length ? `; ${naoIdentificados.length} não identificado(s)` : '')
          + `. Lotes: ${[...lotesTocados].join(',')}`,
        meta: { ...resumo, nao_identificados_lista: naoIdentificados.slice(0, 200), lotes: [...lotesTocados] }
      });

      return res.json({ ok: true, simular: false, atualizados: total, lotes: [...lotesTocados], ...resumo,
        lotes_criados: adocao ? adocao.lotes_criados : 0,
        mensagem: `${total} título(s) registrado(s) pelo .RET. ${destino}` });
    } catch (err) {
      console.error('boleto-adotar-retorno:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// Exportado para teste (o loader so usa o default).
module.exports.resolverPeloSeuNumero = resolverPeloSeuNumero;

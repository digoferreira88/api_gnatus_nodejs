// POST /financeiro/boleto-importar-retorno
//
// Recebe o conteudo de um arquivo de retorno bancario (.RET) em base64, vindo
// do upload na Intranet, e repassa pro Protheus (services/protheusRetorno ->
// endpoint Diego `Cobranca/importar-retorno`).
//
//   simular:true  -> dry-run (preview, nao grava)
//   simular:false -> REGISTRA os titulos no Protheus (E1_OCORREN / E1_NUMBCO)
//
// Baixa dos titulos pagos (2026-09-15) — `baixar:true`:
//   O endpoint do Diego (build R39+, em producao desde 18/08) baixa via
//   MSExecAuto FINA070 as ocorrencias de liquidacao do arquivo. A baixa grava
//   SE1 + SE5 (movimento bancario) + contabilidade; desfazer exige estorno.
//   Por isso:
//     - simular:true  + baixar:true -> sempre permitido (lista o que SERIA baixado)
//     - simular:false + baixar:true -> so com BOLETO_BAIXA_RETORNO_ATIVO=1 no .env
//       (desligado ate o financeiro validar a primeira previa com arquivo real)
//   Depois de uma baixa real, os lotes que contem os titulos sao
//   re-sincronizados a partir da SE1 (services/boletoSincronizar): o LIQUIDADO
//   vem da verdade do Protheus, nao do detalhes[] da resposta.
//
// Quem grava no Protheus e' o endpoint do Diego; a intranet so le a SE1.
// Auditoria CRITICO em qualquer escrita real. Permissao 8005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const Auditoria = require('../../services/auditoria');
const ProtheusRetorno = require('../../services/protheusRetorno');
const CnabFiltro = require('../../services/cnabRetornoFiltro');
const BoletoAdotar = require('../../services/boletoAdotar');
const BoletoSincronizar = require('../../services/boletoSincronizar');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

const baixaRealAtiva = () => trim(process.env.BOLETO_BAIXA_RETORNO_ATIVO) === '1';

// Status que o registro (sem baixa) ja devolvia — nao sao "desconhecidos".
const STATUS_REGISTRO = new Set(['REGISTRADO', 'LIQUIDADO', 'REJEITADO', 'NAO_LOCALIZADO', 'OUTRO']);

// Valor efetivamente pago. Nomes seguem o spec; os alternativos cobrem variacao
// de nomenclatura na resposta da R39, que ainda nao vimos com arquivo real.
const valorPago = (d) => N(d && (d.valor_pago ?? d.valor_recebido ?? d.valor_liquidado ?? d.valor));

/**
 * Resume a parte de BAIXA do detalhes[].
 *
 * O formato exato da resposta da R39 do Diego nao foi conferido contra um
 * arquivo real (o fonte nao esta com a gente). Segue o spec
 * docs/spec-diego-baixa-retorno-fina070.md e e' tolerante a variacoes: status
 * de baixa sao reconhecidos por conteudo (…BAIX…), e qualquer status fora do
 * esperado vai para `status_nao_mapeados`, pra ser revisto na 1a previa.
 */
function resumirBaixa(body) {
  const arr = Array.isArray(body && body.detalhes) ? body.detalhes : [];
  const resumo = { titulos: 0, valor_total: 0, ja_baixados: 0, erros: 0, status_nao_mapeados: [] };
  const naoMapeados = new Set();
  for (const d of arr) {
    const st = trim(d && d.status).toUpperCase();
    if (!st) continue;
    const ehBaixa = st.includes('BAIX');
    if (ehBaixa && st.includes('ERRO')) resumo.erros++;
    else if (ehBaixa && st.startsWith('JA_')) resumo.ja_baixados++;
    else if (ehBaixa) { resumo.titulos++; resumo.valor_total += valorPago(d); }
    else if (!STATUS_REGISTRO.has(st)) naoMapeados.add(st);
  }
  resumo.valor_total = Math.round(resumo.valor_total * 100) / 100;
  resumo.status_nao_mapeados = [...naoMapeados];
  // Arquivo com liquidacoes mas nenhuma baixa indicada: ou o formato da resposta
  // difere do spec, ou o endpoint nao processou a baixa. Nao liberar a baixa
  // real antes de entender qual dos dois.
  if (resumo.titulos === 0 && resumo.ja_baixados === 0 && N(body && body.qtd_liquidados) > 0) {
    resumo.aviso = `O arquivo tem ${N(body.qtd_liquidados)} liquidação(ões), mas o Protheus não indicou nenhuma baixa. Confira com a TI antes de liberar a baixa real.`;
  }
  return resumo;
}

// Chave (prefixo, numero, parcela) de uma linha do detalhes[]. Aceita campos
// separados ou `titulo: "089553/01"`.
function chaveDoDetalhe(d) {
  let numero = trim(d && d.numero);
  let parcela = trim(d && d.parcela);
  if (!numero && trim(d && d.titulo)) {
    const [n, p] = trim(d.titulo).split('/');
    numero = trim(n); parcela = trim(p);
  }
  if (!numero) return null;
  return { prefixo: trim(d && d.prefixo), numero, parcela };
}

// Consulta a SE1 quais (prefixo,numero,parcela) estao com E1_STATUS='B'
// (ja baixados). Em lotes de OR-clauses pra respeitar o limite de params.
async function buscarBaixados(Protheus, chaves) {
  const baixados = new Set();
  const BATCH = 80;
  for (let b = 0; b < chaves.length; b += BATCH) {
    const slice = chaves.slice(b, b + BATCH);
    const p = {};
    const ors = slice.map((t, j) => {
      p[`pf${j}`] = t.prefixo; p[`nu${j}`] = t.numero; p[`pa${j}`] = t.parcela;
      return `(RTRIM(E1_PREFIXO)=@pf${j} AND RTRIM(E1_NUM)=@nu${j} AND RTRIM(E1_PARCELA)=@pa${j})`;
    }).join(' OR ');
    const rows = await Protheus.connectAndQuery(`
      SELECT RTRIM(E1_PREFIXO) prefixo, RTRIM(E1_NUM) numero, RTRIM(E1_PARCELA) parcela,
             RTRIM(E1_STATUS) status, RTRIM(E1_BAIXA) baixa
        FROM SE1010 WITH (NOLOCK)
       WHERE D_E_L_E_T_<>'*' AND E1_FILIAL='01' AND (${ors})`, p);
    rows.forEach(r => {
      if (trim(r.status) === 'B' || trim(r.baixa).length >= 8) {
        baixados.add(`${trim(r.prefixo)}|${trim(r.numero)}|${trim(r.parcela)}`);
      }
    });
  }
  return baixados;
}

module.exports = (app) => ({
  verb: 'post',
  route: '/boleto-importar-retorno',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const user = req.user && req.user[0];
    const conteudoBase64 = trim(req.body?.conteudo_base64);
    const nomeArquivo = trim(req.body?.nome_arquivo);
    const banco = trim(req.body?.banco);
    const agencia = trim(req.body?.agencia);
    const conta = trim(req.body?.conta);
    const simular = req.body?.simular !== false;   // default seguro: dry-run
    const baixar = req.body?.baixar === true;      // default seguro: so registro

    if (!conteudoBase64) {
      return res.status(400).json({ message: 'Envie o conteudo do arquivo (.RET) em conteudo_base64.' });
    }
    // No import REAL o endpoint Diego precisa de banco+agencia+conta pra fazer
    // o DbSeek na SA6/SEE (achar a carteira / EE_DIRREC). Sem isso da LAYOUT_NAO_SUPORTADO.
    if (!simular && (!banco || !agencia || !conta)) {
      return res.status(400).json({ message: 'Para o import real, informe banco, agencia e conta da carteira (carteira do borderô).' });
    }

    // Trava da baixa real: so passa com o gate ligado no .env.
    if (!simular && baixar && !baixaRealAtiva()) {
      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: 'RETORNO_BAIXA_BLOQUEADA', severidade: 'AVISO',
        req, entidade: 'boleto_retorno_arquivo', entidadeId: nomeArquivo || '(sem nome)',
        descricao: `Baixa real pelo retorno ${nomeArquivo || '(arquivo)'} bloqueada — BOLETO_BAIXA_RETORNO_ATIVO desligado`,
        meta: { arquivo: nomeArquivo, banco }
      });
      return res.status(409).json({
        ok: false, codigo_erro: 'BAIXA_REAL_DESATIVADA',
        mensagem: 'A baixa real pelo retorno ainda está desativada. Valide a simulação com o financeiro; a TI libera a baixa em seguida. Para só registrar os títulos, importe sem marcar "baixar títulos pagos".',
        simular: false, baixar: true, baixa_real_ativa: false
      });
    }

    try {
      const operadorEmail = trim(user?.EMAIL) || `id_${user?.ID}`;

      // ===== Pre-filtro Santander (033): remove linhas de titulo JA BAIXADO =====
      // O endpoint do Diego estourava HTTP 500 ao reprocessar a liquidacao de um
      // titulo ja baixado (E1_STATUS='B'). Como sao no-op, removemos do arquivo
      // ANTES de enviar — destravando os registros/baixas das demais linhas.
      // Com baixar:true continua valido: titulo ja baixado nao tem o que baixar.
      // So Santander; Itau (341) funciona e nao e' tocado.
      let conteudoEnvio = conteudoBase64;
      let filtro = null;
      if (banco === '033') {
        try {
          const texto = Buffer.from(conteudoBase64, 'base64').toString('latin1');
          const chaves = CnabFiltro.extrairChaves(texto);
          if (chaves.length) {
            const baixados = await buscarBaixados(app.services.Protheus, chaves);
            if (baixados.size) {
              const res2 = CnabFiltro.filtrarBaixados(texto, baixados);
              if (res2.removidos.length) {
                conteudoEnvio = Buffer.from(res2.conteudo, 'latin1').toString('base64');
                filtro = { removidos: res2.removidos.length, mantidos: res2.mantidos, total: res2.total };
                console.log(`boleto-importar-retorno: filtro Santander removeu ${res2.removidos.length} titulo(s) ja baixado(s) de ${res2.total}`);
              }
            }
          }
        } catch (e) {
          // Filtro e' best-effort: se falhar, manda o arquivo original (Diego
          // pode estourar, mas nao pioramos o cenario).
          console.warn('boleto-importar-retorno: falha no pre-filtro Santander —', e.message);
        }
      }

      const r = await ProtheusRetorno.importar({
        filial: '01',
        banco,
        agencia,
        conta,
        nomeArquivo,
        conteudoBase64: conteudoEnvio,
        operador: operadorEmail,
        simular,
        baixar
      });

      const body = r.body || {};
      // Ecoa o modo pro front: o import real sempre repete o modo simulado.
      body.simular = simular;
      body.baixar = baixar;
      body.baixa_real_ativa = baixaRealAtiva();
      if (filtro) body.filtro_ja_baixados = filtro;
      if (baixar && r.ok) body.resumo_baixa = resumirBaixa(body);

      const rb = body.resumo_baixa;
      const txtBaixa = rb
        ? ` · baixa${simular ? ' (prévia)' : ''}: ${rb.titulos} título(s), R$ ${rb.valor_total.toFixed(2)}, ${rb.ja_baixados} já baixado(s), ${rb.erros} erro(s)`
        : '';

      // Auditoria. Severidade reflete o RESULTADO, nao so o modo:
      //   simular + ok      -> INFO   (preview sem gravar)
      //   simular + falhou   -> ALERTA (Diego deu erro; nao era so "0 registros")
      //   real    + ok      -> CRITICO (escreveu no Protheus)
      //   real    + falhou   -> ALERTA
      const sev = r.ok ? (simular ? 'INFO' : 'CRITICO') : 'ALERTA';
      // Mensagem de erro do Diego: pode vir como codigo_erro/mensagem
      // (estruturado) ou como {code, message} (500 generico do AppServer).
      const erroProtheus = body.codigo_erro || body.mensagem || body.message
        || (body.code ? `HTTP ${body.code}` : '') || 'erro Protheus (sem detalhe)';
      const acao = (simular ? 'RETORNO_SIMULAR' : 'RETORNO_IMPORTAR') + (baixar ? '_BAIXA' : '');
      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao,
        severidade: sev,
        req, entidade: 'boleto_retorno_arquivo', entidadeId: nomeArquivo || '(sem nome)',
        descricao: !r.ok
          ? `FALHA ${simular ? 'na simulação' : 'ao importar'} do retorno ${nomeArquivo || '(arquivo)'}${baixar ? ' com baixa' : ''} (HTTP ${r.httpStatus} — ${erroProtheus})`
          : (simular
            ? `Simulou import do retorno ${nomeArquivo || '(arquivo)'} — ${N(body.qtd_registros)} registro(s)${txtBaixa}`
            : `IMPORTOU retorno ${nomeArquivo || '(arquivo)'} no Protheus — ${N(body.qtd_registrados)} reg, ${N(body.qtd_liquidados)} liq, ${N(body.qtd_rejeitados)} rej (de ${N(body.qtd_registros)})${txtBaixa}`),
        meta: {
          arquivo: nomeArquivo, banco: body.banco || banco, layout: body.layout, simular, baixar,
          qtd_registros: N(body.qtd_registros), qtd_registrados: N(body.qtd_registrados),
          qtd_liquidados: N(body.qtd_liquidados), qtd_rejeitados: N(body.qtd_rejeitados),
          qtd_nao_localizados: N(body.qtd_nao_localizados),
          resumo_baixa: rb || undefined,
          httpStatus: r.httpStatus, codigo_erro: body.codigo_erro,
          // Pra diagnosticar erros intermitentes do Diego (BANCO_INVALIDO, etc),
          // capturamos a mensagem e o build_tag do Protheus quando vier erro.
          mensagem: body.mensagem,
          build_tag: body.build_tag,
          // 500 generico do AppServer vem como {code, message} sem build_tag —
          // capturamos pra distinguir exception AdvPL de erro de negocio.
          http_code: body.code, http_message: body.message,
          raw: typeof body.raw === 'string' ? body.raw.slice(0, 500) : undefined,
          // Pre-filtro Santander: quantos titulos ja-baixados foram removidos
          filtro_ja_baixados: filtro || undefined,
          // Conta enviada pra rastrear formato (SA6 vs SEE)
          conta_enviada: trim(req.body?.conta)
        }
      });

      // ===== Auto-adoção (2026-07-08) =====
      // Import REAL de um borderô feito FORA da intranet (direto no Protheus) não
      // gera boletos disparáveis por si só — não há lote na intranet. Depois que o
      // endpoint registra no SE1 (E1_OCORREN='02' + nosso número), adotamos os
      // ÓRFÃOS desse banco: cria lote retroativo -> ficam disparáveis, sem passo
      // manual. Idempotente (só adota o que ainda não está em lote). Best-effort:
      // se falhar, NÃO quebra a resposta do import.
      if (!simular && r.ok && banco) {
        try {
          const adocao = await BoletoAdotar.adotarSe1({
            Pg: app.services.Pg, Protheus: app.services.Protheus, user, filtroBanco: banco
          });
          body.auto_adotados = adocao.adotados;
          body.auto_lotes = adocao.lotes_criados;
          if (adocao.adotados) {
            Auditoria.registrar(app, {
              modulo: 'Financeiro', submodulo: 'EnvioBoleto',
              acao: 'ADOTAR_SE1', severidade: 'INFO', req,
              entidade: 'lote', entidadeId: adocao.lotes.map(l => l.id).join(','),
              descricao: `Auto-adotou ${adocao.adotados} título(s) da SE1 após import do retorno ${nomeArquivo || '(arquivo)'} — ${adocao.lotes_criados} lote(s), ficaram disparáveis`,
              meta: { origem: 'importar-retorno', banco, adotados: adocao.adotados, lotes: adocao.lotes }
            });
          }
        } catch (e) {
          console.warn('boleto-importar-retorno: auto-adotar-se1 falhou —', e.message);
        }
      }

      // ===== Re-sincronizacao pos-baixa (2026-09-15) =====
      // Depois de uma baixa REAL, marca os titulos como LIQUIDADO nos lotes
      // lendo a SE1 (mesmo nucleo do "Sincronizar" do Histórico de lotes).
      // Best-effort: a baixa ja aconteceu no Protheus; se isto falhar, o
      // operador sincroniza manualmente.
      if (!simular && baixar && r.ok) {
        body.lotes_sincronizados = [];
        const vistos = new Set();
        const chaves = [];
        for (const d of (Array.isArray(body.detalhes) ? body.detalhes : [])) {
          const st = trim(d && d.status).toUpperCase();
          if (st.includes('ERRO') || !(st.includes('BAIX') || st.includes('LIQUID'))) continue;
          const c = chaveDoDetalhe(d);
          if (!c) continue;
          const k = `${c.prefixo}|${c.numero}|${c.parcela}`;
          if (!vistos.has(k)) { vistos.add(k); chaves.push(c); }
        }

        if (!chaves.length) {
          if (rb && rb.titulos > 0) {
            body.aviso_sincronizacao = 'Os títulos foram baixados, mas não deu para identificá-los na resposta do Protheus. Sincronize os lotes em "Histórico de lotes".';
          }
        } else {
          try {
            const { Pg, Protheus } = app.services;
            const ids = await BoletoSincronizar.lotesDosTitulos({ Pg, chaves });
            for (const id of ids) {
              const s = await BoletoSincronizar.sincronizarLote({ Pg, Protheus, id });
              if (s.encontrado && !s.semTitulos) {
                body.lotes_sincronizados.push({ id, novo_status: s.novoStatus, liquidados: s.stats.LIQUIDADO + s.stats.BAIXADO });
              }
            }
            if (body.lotes_sincronizados.length) {
              Auditoria.registrar(app, {
                modulo: 'Financeiro', submodulo: 'EnvioBoleto',
                acao: 'SINCRONIZAR_BANCO', severidade: 'INFO', req,
                entidade: 'boleto_lote', entidadeId: body.lotes_sincronizados.map(l => l.id).join(','),
                descricao: `Re-sincronizou ${body.lotes_sincronizados.length} lote(s) após baixa pelo retorno ${nomeArquivo || '(arquivo)'}`,
                meta: { origem: 'baixa-retorno', arquivo: nomeArquivo, lotes: body.lotes_sincronizados }
              });
            }
          } catch (e) {
            console.warn('boleto-importar-retorno: re-sincronizacao pos-baixa falhou —', e.message);
            body.aviso_sincronizacao = 'Os títulos foram baixados, mas a sincronização automática dos lotes falhou. Sincronize em "Histórico de lotes".';
          }
        }
      }

      // Repassa o corpo do Protheus (inclui detalhes[]) + status http original
      return res.status(r.httpStatus >= 200 && r.httpStatus < 600 ? r.httpStatus : 502).json(body);
    } catch (err) {
      console.error('boleto-importar-retorno:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

// Exportado para teste unitario do resumo (o loader so usa o default).
module.exports.resumirBaixa = resumirBaixa;
module.exports.chaveDoDetalhe = chaveDoDetalhe;

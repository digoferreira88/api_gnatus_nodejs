// POST /financeiro/boleto-importar-retorno
//
// Recebe o conteudo de um arquivo de retorno bancario (.RET) em base64, vindo
// do upload na Intranet, e repassa pro Protheus (services/protheusRetorno ->
// endpoint Diego). Em simular:true e' dry-run (preview, nao grava). Em
// simular:false o Protheus chama a FINA205() e grava de verdade (registro/baixa).
//
// A Intranet NAO escreve no Protheus — quem grava e' a FINA205 via REST.
// Auditoria CRITICO no import real.
//
// Permissao 8005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const Auditoria = require('../../services/auditoria');
const ProtheusRetorno = require('../../services/protheusRetorno');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

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

    if (!conteudoBase64) {
      return res.status(400).json({ message: 'Envie o conteudo do arquivo (.RET) em conteudo_base64.' });
    }
    // No import REAL o endpoint Diego precisa de banco+agencia+conta pra fazer
    // o DbSeek na SEE (achar a carteira / EE_DIRREC). Sem isso da LAYOUT_NAO_SUPORTADO.
    if (!simular && (!banco || !agencia || !conta)) {
      return res.status(400).json({ message: 'Para o import real, informe banco, agencia e conta da carteira (carteira do borderô).' });
    }

    try {
      const operadorEmail = trim(user?.EMAIL) || `id_${user?.ID}`;
      const r = await ProtheusRetorno.importar({
        filial: '01',
        banco,
        agencia,
        conta,
        nomeArquivo,
        conteudoBase64,
        operador: operadorEmail,
        simular
      });

      const body = r.body || {};

      // Auditoria. Severidade reflete o RESULTADO, nao so o modo:
      //   simular + ok      -> INFO   (preview sem gravar)
      //   simular + falhou   -> ALERTA (Diego deu erro; nao era so "0 registros")
      //   real    + ok      -> CRITICO (escreveu no Protheus)
      //   real    + falhou   -> ALERTA
      // Antes: dry-run que falhava (ex.: HTTP 500 Santander) virava INFO
      // "Simulou ... 0 registros", mascarando a falha. (2026-06-02)
      const sev = r.ok ? (simular ? 'INFO' : 'CRITICO') : 'ALERTA';
      // Mensagem de erro do Diego: pode vir como codigo_erro/mensagem
      // (estruturado) ou como {code, message} (500 generico do AppServer).
      const erroProtheus = body.codigo_erro || body.mensagem || body.message
        || (body.code ? `HTTP ${body.code}` : '') || 'erro Protheus (sem detalhe)';
      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: simular ? 'RETORNO_SIMULAR' : 'RETORNO_IMPORTAR',
        severidade: sev,
        req, entidade: 'boleto_retorno_arquivo', entidadeId: nomeArquivo || '(sem nome)',
        descricao: !r.ok
          ? `FALHA ${simular ? 'na simulação' : 'ao importar'} do retorno ${nomeArquivo || '(arquivo)'} (HTTP ${r.httpStatus} — ${erroProtheus})`
          : (simular
            ? `Simulou import do retorno ${nomeArquivo || '(arquivo)'} — ${N(body.qtd_registros)} registro(s)`
            : `IMPORTOU retorno ${nomeArquivo || '(arquivo)'} no Protheus — ${N(body.qtd_registrados)} reg, ${N(body.qtd_liquidados)} liq, ${N(body.qtd_rejeitados)} rej (de ${N(body.qtd_registros)})`),
        meta: {
          arquivo: nomeArquivo, banco: body.banco || banco, layout: body.layout, simular,
          qtd_registros: N(body.qtd_registros), qtd_registrados: N(body.qtd_registrados),
          qtd_liquidados: N(body.qtd_liquidados), qtd_rejeitados: N(body.qtd_rejeitados),
          qtd_nao_localizados: N(body.qtd_nao_localizados),
          httpStatus: r.httpStatus, codigo_erro: body.codigo_erro,
          // Pra diagnosticar erros intermitentes do Diego (BANCO_INVALIDO, etc),
          // capturamos a mensagem e o build_tag do Protheus quando vier erro.
          mensagem: body.mensagem,
          build_tag: body.build_tag,
          // 500 generico do AppServer vem como {code, message} sem build_tag —
          // capturamos pra distinguir exception AdvPL de erro de negocio.
          http_code: body.code, http_message: body.message,
          raw: typeof body.raw === 'string' ? body.raw.slice(0, 500) : undefined,
          // Conta enviada pra rastrear formato (SA6 vs SEE)
          conta_enviada: trim(req.body?.conta)
        }
      });

      // Repassa o corpo do Protheus (inclui detalhes[]) + status http original
      return res.status(r.httpStatus >= 200 && r.httpStatus < 600 ? r.httpStatus : 502).json(body);
    } catch (err) {
      console.error('boleto-importar-retorno:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

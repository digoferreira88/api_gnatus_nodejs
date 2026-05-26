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

      // Auditoria: dry-run = INFO; import real = CRITICO (escreve no Protheus)
      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: simular ? 'RETORNO_SIMULAR' : 'RETORNO_IMPORTAR',
        severidade: simular ? 'INFO' : (r.ok ? 'CRITICO' : 'ALERTA'),
        req, entidade: 'boleto_retorno_arquivo', entidadeId: nomeArquivo || '(sem nome)',
        descricao: simular
          ? `Simulou import do retorno ${nomeArquivo || '(arquivo)'} — ${N(body.qtd_registros)} registro(s)`
          : (r.ok
            ? `IMPORTOU retorno ${nomeArquivo || '(arquivo)'} no Protheus — ${N(body.qtd_registrados)} reg, ${N(body.qtd_liquidados)} liq, ${N(body.qtd_rejeitados)} rej (de ${N(body.qtd_registros)})`
            : `FALHA ao importar retorno ${nomeArquivo || '(arquivo)'} (HTTP ${r.httpStatus}, ${body.codigo_erro || '?'})`),
        meta: {
          arquivo: nomeArquivo, banco: body.banco || banco, layout: body.layout, simular,
          qtd_registros: N(body.qtd_registros), qtd_registrados: N(body.qtd_registrados),
          qtd_liquidados: N(body.qtd_liquidados), qtd_rejeitados: N(body.qtd_rejeitados),
          qtd_nao_localizados: N(body.qtd_nao_localizados), httpStatus: r.httpStatus, codigo_erro: body.codigo_erro
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

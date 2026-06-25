// Adapter de bureau "faro" (SINC Finance) para o módulo de crédito.
// Executa o workflow configurado (SINC_FARO_WORKFLOW_ID), faz polling até o
// status terminal e normaliza o resultado no formato padrão consumido por
// creditoBureau.blend() (mesmo contrato do adapter quod).
//
// A decisão/score saem do output_data do workflow; os dados de bureau, do
// plugin_data. Enquanto o workflow de PRODUÇÃO (serasa/bigdatacorp) não for
// publicado, o workflow de testes só ecoa dados → score vem null e o blend usa
// apenas o score interno (sem efeito) — mas o encanamento já está pronto.
// Para tornar a Faro a fonte ativa: tab_credito_config chave='bureau' → fonteAtiva='faro'.

const Faro = require('../sincFaro');

function disponivel() { return Faro.disponivel(); }

// Recebe o CPF/CNPJ (com ou sem máscara). Retorna { httpStatus, resultado }.
async function consultar(documento) {
  if (!disponivel()) {
    const e = new Error('Faro não configurado — defina SINC_FARO_* e SINC_FARO_WORKFLOW_ID no .env.');
    e.naoConfigurado = true; throw e;
  }
  const exec = await Faro.analisar(documento, { customData: { origem: 'intranet-credito' } });
  const status = String((exec && exec.status) || '').toLowerCase();
  if (status && !['completed', 'success'].includes(status)) {
    const e = new Error('Faro: execução terminou em "' + (exec.status || '?') + '" (sem resultado utilizável).');
    e.httpStatus = 502; e.raw = exec; throw e;
  }
  return { httpStatus: 200, resultado: Faro.normalizar(exec) };
}

module.exports = { disponivel, consultar };

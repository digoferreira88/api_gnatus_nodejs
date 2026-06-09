// Reexporta os adapters de bureau de crédito.
//
// NECESSÁRIO: o auto-loader (config/loader.js) faz require() de CADA entrada de
// services/ — inclusive este diretório. Sem este index.js, require('services/bureau')
// falha com MODULE_NOT_FOUND e derruba o boot da API inteira (502 no login).
// Ao adicionar novos bureaus (serasa, boavista...), exportá-los aqui também.
module.exports = { quod: require('./quod') };

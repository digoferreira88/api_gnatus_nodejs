// GET /integracao/clientes-pipefy/incompletos — lista clientes do SA1 que não
// podem ser espelhados no Pipefy por faltar campo obrigatório (CPF/CNPJ, e-mail,
// CEP, telefone...). Saída acionável p/ o cadastro corrigir no Protheus — depois
// entram sozinhos no ciclo seguinte. Perm 1033 / 0.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1033, 0]);
const PipefyClientes = require('../../services/pipefyClientes');

module.exports = (app) => ({
  verb: 'get',
  route: '/clientes-pipefy/incompletos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const limite = Math.min(2000, Math.max(1, parseInt(req.query.limite, 10) || 500));
    try {
      const lista = await PipefyClientes.listarIncompletos({ Protheus }, limite);
      return res.json({ total: lista.length, limite, clientes: lista });
    } catch (err) {
      console.error('Erro clientes-pipefy/incompletos:', err);
      return res.status(500).json({ message: 'Erro ao listar: ' + err.message });
    }
  }
});

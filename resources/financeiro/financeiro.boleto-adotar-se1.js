// POST /financeiro/boleto-adotar-se1
// Body: { banco?: string } — opcional, filtra por E1_PORTADO especifico
//
// "Adota" titulos REGISTRADOS na SE1 do Protheus que ainda nao passaram pelo
// fluxo de lotes da Intranet (remessas feitas direto pelo Protheus, ou apos
// import do retorno de um bordero criado externamente). Cria lote(s) RETORNADO
// retroativo(s) por carteira pra que esses titulos passem a aparecer em
// "Disparar boletos". Logica em services/boletoAdotar.js (fonte unica, tambem
// usada pelo auto-adotar do importar-retorno).
//
// Permissao 8005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const Auditoria = require('../../services/auditoria');
const BoletoAdotar = require('../../services/boletoAdotar');

const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/boleto-adotar-se1',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    const filtroBanco = trim(req.body?.banco);

    try {
      const r = await BoletoAdotar.adotarSe1({ Pg, Protheus, user, filtroBanco });

      if (r.adotados) {
        Auditoria.registrar(app, {
          modulo: 'Financeiro', submodulo: 'EnvioBoleto',
          acao: 'ADOTAR_SE1', severidade: 'INFO', req,
          entidade: 'lote', entidadeId: r.lotes.map(l => l.id).join(','),
          descricao: `Adotou ${r.adotados} titulo(s) da SE1 em ${r.lotes_criados} lote(s) retroativo(s)`,
          meta: { filtroBanco, adotados: r.adotados, lotes_criados: r.lotes_criados, lotes: r.lotes }
        });
      }

      return res.json(r);
    } catch (err) {
      console.error('boleto-adotar-se1:', err);
      return res.status(500).json({ message: 'Erro ao adotar titulos da SE1: ' + err.message });
    }
  }
});

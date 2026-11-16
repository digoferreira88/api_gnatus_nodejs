// GET /ciosp/adm/protheus/:uuid — o painel "Lançar no Protheus" da fila do ADM: cliente
// (encontrado, novo ou várias lojas), BU, vendedor, condição, TES por item, totais, as
// listas do Protheus e o que falta para o botão "Inserir no Protheus e finalizar".
// Perm 19004. Só lê (PG e SQL do Protheus). Spec 2026-11-13, seções 4 e 6.2.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19004, 0]);
const D = require('../../services/ciospDocs');
const CP = require('../../services/ciospProtheus');
const E = require('../../services/ciospProtheusEnvio');

// A última tentativa, como a tela mostra.
function resumoUltima(u) {
  if (!u) return null;
  let mensagem = null, inconsistencias = [];
  if (u.resultado && !['criado', 'ja_existia'].includes(u.resultado)) {
    const lido = E.interpretarResposta({ http: u.http, corpo: u.resposta, erro: u.http ? null : 'TIMEOUT' });
    mensagem = lido.mensagem; inconsistencias = lido.inconsistencias;
  }
  return { tentativa: u.tentativa, simulado: !!u.simulado, resultado: u.resultado || null, mensagem, inconsistencias, em: u.enviado_em };
}

module.exports = (app) => ({
  verb: 'get',
  route: '/adm/protheus/:uuid',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const uuid = D.trim(req.params.uuid).toLowerCase();
    try {
      const r = await Pg.connectAndQuery(`SELECT * FROM tab_ciosp_pedido WHERE uuid = @uuid`, { uuid });
      if (!r.length) return res.status(404).json({ message: 'Pedido não encontrado.' });
      const { _pedido, _ultima, ...proposta } = await CP.carregarProposta(app, r[0]);
      return res.json({ ...proposta, simular: process.env.CIOSP_PROTHEUS_SIMULAR === '1', ultima: resumoUltima(_ultima) });
    } catch (err) {
      console.error('ciosp/adm-protheus:', err.message);
      return res.status(500).json({ message: 'Erro ao montar o painel do Protheus: ' + err.message });
    }
  }
});

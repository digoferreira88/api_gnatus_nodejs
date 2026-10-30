// POST /universidade/rh/sincronizar — puxa agora cargos e colaboradores do Protheus e
// recalcula os requisitos (o mesmo que o job diário faz). Perm 15004/15003.

const { ESCREVER, requirePerm, usuario, audit } = require('./_rh');
const UniRh = require('../../services/universidadeRh');

module.exports = (app) => ({
  verb: 'post',
  route: '/rh/sincronizar',
  middlewares: [requirePerm(app, ESCREVER)],

  handler: async (req, res) => {
    const u = usuario(req);
    try {
      const resumo = await UniRh.sincronizar(app, { origem: 'manual', userId: u.ID || null });
      await audit(app, req, 'SINCRONIZAR', 'uni_colaborador', null,
        `Sincronizou com o Protheus: ${resumo.colaboradores.ativos} ativos, ${resumo.colaboradores.admissoes} admissão(ões), ` +
        `${resumo.colaboradores.mudancasCargo} mudança(s) de cargo, ${resumo.colaboradores.desligamentos} desligamento(s)`, resumo);
      return res.json({ ok: true, resumo });
    } catch (err) {
      console.error('[universidade/rh/sincronizar]', err);
      return res.status(502).json({ message: 'Falha ao sincronizar com o Protheus. Tente novamente em alguns minutos.' });
    }
  }
});

// GET /qualificacao/status/:codigo — consulta compacta para integrações (ERP, outros
// módulos): o fornecedor está apto? IQF, classe, situação dos documentos.
// "apto" = ativo e APROVADO/APROVADO_COM_RESTRICAO. "recebimentoLiberado" considera também o
// bloqueio por plano de ação (classes C/D). Perm 23001+ (JWT da intranet).

const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');

module.exports = (app) => ({
  verb: 'get',
  route: '/status/:codigo',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const codigo = R.normalizarCodigo(req.params.codigo);
    try {
      const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE codigo = @c`, { c: codigo });
      if (!f) return res.status(404).json({ codigo, cadastrado: false, apto: false, message: 'Fornecedor não cadastrado no módulo de qualificação.' });
      const monit = R.monitorado(f);
      const ck = monit ? await Q.checklistFornecedor(Pg, f) : null;
      const regra = await Q.regraAtiva(Pg);
      return res.json({
        codigo: f.codigo, razaoSocial: f.razao_social, cadastrado: true,
        apto: f.ativo && Q.STATUS_ATIVOS.includes(f.status_qualificacao),
        recebimentoLiberado: f.ativo && Q.STATUS_ATIVOS.includes(f.status_qualificacao), inspecao100: f.inspecao_100,
        status: f.status_qualificacao, ativo: f.ativo, criticidades: R.normCriticidades(f.criticidades), monitorado: monit,
        suspensaoTipo: f.suspensao_tipo, motivoSuspensao: f.motivo_suspensao, qualificacaoValidaAte: f.qualificacao_valida_ate,
        iqf: f.iqf_medio != null ? Number(f.iqf_medio) : null, qtdInspecoes: f.qtd_inspecoes, ultimaInspecao: f.ultima_inspecao,
        classe: f.classificacao, classeRotulo: monit ? R.classificar(regra.conteudo, f.iqf_medio)?.rotulo || null : null,
        documentos: ck ? { completo: ck.completo, pendentes: ck.pendentes, vencidos: ck.vencidos, vencendo: ck.vencendo } : null
      });
    } catch (err) { return Q.falha(res, 'consultar o status', err); }
  }
});

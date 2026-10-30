// PUT /qualificacao/fornecedores/:id/plano-iqf — a Engenharia registra o PLANO DE AÇÃO que o
// fornecedor das classes C e D enviou (decisão 30/10/2026: "campo para marcar como plano de
// ação e local para anexar"). O arquivo vai em /anexos (entidade fornecedor, categoria
// PLANO_ACAO). Registrado o plano, o recebimento é LIBERADO:
//   classe C → volta a receber por amostragem;
//   classe D → só com inspeção de 100% do lote (inspecao_100 continua ligado).
// Perm 23003+ (Engenharia).

const Q = require('../../services/qfCore');
const { avisarLiberacao } = require('./qualificacao.fornecedor-status');

module.exports = (app) => ({
  verb: 'put',
  route: '/fornecedores/:id/plano-iqf',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    const b = req.body || {};
    try {
      const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id });
      if (!f) return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      const plano = Q.nul(b.plano_acao_iqf);
      if (!plano) return res.status(400).json({ message: 'Descreva o plano de ação recebido do fornecedor (e anexe o documento).' });
      const [anexo] = await Pg.connectAndQuery(
        `SELECT COUNT(*)::int n FROM tab_qf_anexo WHERE entidade = 'fornecedor' AND entidade_id = @id AND categoria = 'PLANO_ACAO' AND NOT excluido
            AND enviado_em >= COALESCE(@desde::timestamptz, '1900-01-01')`, { id, desde: f.suspenso_em || null });
      const u = Q.usuario(req);
      const bloqueadoPorPlano = f.status_qualificacao === 'SUSPENSO' && Q.TIPOS_PLANO.includes(f.suspensao_tipo);
      const ehD = f.suspensao_tipo === 'PLANO_ACAO_D' || f.classificacao === 'D';
      const [ult] = await Pg.connectAndQuery(`SELECT aprovacao_resultado FROM tab_qf_qualificacao WHERE fornecedor_id = @id AND status = 'APROVADO' ORDER BY aprovacao_em DESC NULLS LAST LIMIT 1`, { id });
      const volta = ult && /COM_RESTRICAO$/.test(ult.aprovacao_resultado || '') ? 'APROVADO_COM_RESTRICAO' : 'APROVADO';
      const [novo] = await Pg.connectAndQuery(
        `UPDATE tab_qf_fornecedor SET plano_acao_iqf = @p, plano_acao_iqf_em = NOW(), plano_acao_iqf_por = @u,
                inspecao_100 = CASE WHEN @d::boolean THEN TRUE ELSE inspecao_100 END,
                status_qualificacao = CASE WHEN @lib::boolean THEN @volta ELSE status_qualificacao END,
                suspensao_tipo = CASE WHEN @lib::boolean THEN NULL ELSE suspensao_tipo END,
                motivo_suspensao = CASE WHEN @lib::boolean THEN NULL ELSE motivo_suspensao END,
                suspenso_em = CASE WHEN @lib::boolean THEN NULL ELSE suspenso_em END,
                atualizado_por = @u, atualizado_em = NOW()
          WHERE id = @id RETURNING *`, { p: plano, u: u.id, d: ehD, lib: bloqueadoPorPlano, volta, id });
      await Q.log(Pg, req, {
        entidade: 'fornecedor', entidadeId: id, fornecedorId: id, acao: 'PLANO_IQF',
        mudancas: [{ campo: 'plano_acao_iqf', de: f.plano_acao_iqf, para: plano },
          ...(bloqueadoPorPlano ? [{ campo: 'status_qualificacao', de: 'SUSPENSO', para: volta }] : []),
          ...(ehD ? [{ campo: 'inspecao_100', de: f.inspecao_100, para: true }] : [])],
        motivo: Q.nul(b.motivo) || (bloqueadoPorPlano ? 'plano de ação registrado — recebimento liberado' : 'plano de ação registrado')
      });
      if (bloqueadoPorPlano) await avisarLiberacao(app, f, `plano de ação registrado pela Engenharia${ehD ? ' (classe D: recebimento só com inspeção 100%)' : ''}`);
      return res.json({ ok: true, fornecedor: novo, liberado: bloqueadoPorPlano, inspecao100: novo.inspecao_100, semAnexo: anexo.n === 0 });
    } catch (err) { return Q.falha(res, 'registrar o plano de ação', err); }
  }
});

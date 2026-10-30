// PUT /qualificacao/processos/:pid — anda com o processo. Perm 23003+ (Engenharia).
//
// body (todos opcionais):
//   etapa, criticidade_definida, status (EM_ANDAMENTO | PAUSADO | CANCELADO), motivo
//   auditoria_necessaria (true|false|null) + auditoria_justificativa — decisão da Engenharia,
//     registrada com justificativa (PRO 4.1 e Nota do 5.6)
//   amostra_dispensada + amostra_justificativa
//   plano_acao, prazo_regularizacao — pendências de resultado "com restrição"
//   analise: { documental: { parecer }, desempenho: { parecer, reclamacoes, planos },
//              alteracoes: { decidido, aceitas, questionario, auditoria, novaAmostra, parecer } }
//     (requalificação — PRO 5.10.1; cada bloco é mesclado ao que já existe)

const Q = require('../../services/qfCore');
const P = require('../../services/qfProcesso');

const data = (v) => { const s = Q.trim(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };

module.exports = (app) => ({
  verb: 'put',
  route: '/processos/:pid',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const pid = Number(req.params.pid);
    const b = req.body || {};
    try {
      const [atual] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_qualificacao WHERE id = @id`, { id: pid });
      if (!atual) return res.status(404).json({ message: 'Processo não encontrado.' });
      if (!['EM_ANDAMENTO', 'PAUSADO'].includes(atual.status)) return res.status(409).json({ message: `Processo já encerrado (${atual.status}).` });
      const u = Q.usuario(req);
      const novo = { ...atual, analise: { ...(atual.analise || {}) } };
      const etapas = [...P.ETAPAS_INICIAL, ...P.ETAPAS_REQUALIFICACAO];
      if (b.etapa && etapas.some(e => e.id === b.etapa)) novo.etapa = b.etapa;
      if ('criticidade_definida' in b) novo.criticidade_definida = !!b.criticidade_definida;
      if ('auditoria_necessaria' in b) {
        novo.auditoria_necessaria = b.auditoria_necessaria === null ? null : !!b.auditoria_necessaria;
        novo.auditoria_justificativa = Q.nul(b.auditoria_justificativa);
        if (novo.auditoria_necessaria !== null && !novo.auditoria_justificativa) return res.status(400).json({ message: 'Justifique a decisão sobre a auditoria (fica registrada nas conclusões do FORM — PRO 7.3.7 item 5.6).' });
      }
      if ('amostra_dispensada' in b) {
        novo.amostra_dispensada = !!b.amostra_dispensada;
        novo.amostra_justificativa = novo.amostra_dispensada ? Q.nul(b.amostra_justificativa) : null;
        if (novo.amostra_dispensada && !novo.amostra_justificativa) return res.status(400).json({ message: 'Justifique a dispensa da amostra.' });
      }
      if ('plano_acao' in b) novo.plano_acao = Q.nul(b.plano_acao);
      if ('prazo_regularizacao' in b) novo.prazo_regularizacao = data(b.prazo_regularizacao);
      if (b.analise && typeof b.analise === 'object') {
        const an = b.analise;
        if (an.documental) novo.analise.documental = { ...(novo.analise.documental || {}), parecer: Q.nul(an.documental.parecer), por: u.nome, em: new Date().toISOString() };
        if (an.desempenho) {
          const regra = await Q.regraAtiva(Pg);
          const snap = await Q.desempenho12m(Pg, regra.conteudo, atual.fornecedor_id);
          novo.analise.desempenho = { ...(novo.analise.desempenho || {}), parecer: Q.nul(an.desempenho.parecer), reclamacoes: Q.nul(an.desempenho.reclamacoes),
            planos: Q.nul(an.desempenho.planos), indicadores: snap, por: u.nome, em: new Date().toISOString() };
        }
        if (an.alteracoes) {
          const a = an.alteracoes;
          novo.analise.alteracoes = { decidido: a.decidido !== false, aceitas: a.aceitas === false ? false : true,
            questionario: !!a.questionario, auditoria: !!a.auditoria, novaAmostra: !!a.novaAmostra, parecer: Q.nul(a.parecer), por: u.nome, em: new Date().toISOString() };
          if (!novo.analise.alteracoes.parecer) return res.status(400).json({ message: 'Registre o parecer da análise das alterações declaradas.' });
        }
        if (an.documental && !novo.analise.documental.parecer) return res.status(400).json({ message: 'Registre o parecer da análise documental.' });
        if (an.desempenho && !novo.analise.desempenho.parecer) return res.status(400).json({ message: 'Registre o parecer da análise de desempenho.' });
      }
      if (b.status) {
        if (!['EM_ANDAMENTO', 'PAUSADO', 'CANCELADO'].includes(b.status)) return res.status(400).json({ message: 'Status inválido.' });
        if (b.status !== atual.status && b.status !== 'EM_ANDAMENTO' && !Q.nul(b.motivo)) return res.status(400).json({ message: 'Informe o motivo.' });
        novo.status = b.status;
      }
      const campos = ['etapa', 'criticidade_definida', 'auditoria_necessaria', 'auditoria_justificativa', 'amostra_dispensada', 'amostra_justificativa', 'plano_acao', 'prazo_regularizacao', 'status'];
      const mud = Q.diff(atual, novo, campos);
      const analiseMudou = JSON.stringify(atual.analise || {}) !== JSON.stringify(novo.analise);
      if (analiseMudou) for (const k of Object.keys(novo.analise)) if (JSON.stringify((atual.analise || {})[k]) !== JSON.stringify(novo.analise[k])) mud.push({ campo: `analise.${k}`, de: null, para: novo.analise[k].parecer || JSON.stringify(novo.analise[k]) });
      if (!mud.length) return res.json({ ok: true, processo: atual });
      const [proc] = await Pg.connectAndQuery(
        `UPDATE tab_qf_qualificacao SET ${campos.map(c => `${c} = @${c}`).join(', ')}, analise = @analise::jsonb,
                concluido_em = CASE WHEN @cancelou::boolean THEN NOW() ELSE concluido_em END,
                atualizado_por = @u, atualizado_em = NOW()
          WHERE id = @id RETURNING *`,
        { ...Object.fromEntries(campos.map(c => [c, novo[c]])), analise: JSON.stringify(novo.analise), cancelou: novo.status === 'CANCELADO', u: u.id, id: pid });
      await Q.log(Pg, req, { entidade: 'qualificacao', entidadeId: pid, fornecedorId: atual.fornecedor_id, acao: 'ATUALIZAR', mudancas: mud, motivo: b.motivo });
      return res.json({ ok: true, processo: proc });
    } catch (err) { return Q.falha(res, 'atualizar o processo', err); }
  }
});

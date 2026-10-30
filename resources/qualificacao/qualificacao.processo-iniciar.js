// POST /qualificacao/fornecedores/:id/processos — abre um processo: INICIAL (qualificação),
// REQUALIFICACAO (anual — PRO 5.10, FORM 7.3.28) ou REATIVACAO (de reprovado: refaz a
// qualificação). Um aberto por fornecedor. Perm 23003+ (Engenharia).

const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');

module.exports = (app) => ({
  verb: 'post',
  route: '/fornecedores/:id/processos',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    const b = req.body || {};
    const tipo = ['INICIAL', 'REQUALIFICACAO', 'REATIVACAO'].includes(b.tipo) ? b.tipo : 'INICIAL';
    try {
      const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id });
      if (!f) return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      if (tipo === 'REQUALIFICACAO') {
        if (!R.monitorado(f)) return res.status(400).json({ message: 'Requalificação anual é para fornecedor crítico (PRO 7.3.7 item 5.10).' });
        if (!['APROVADO', 'APROVADO_COM_RESTRICAO', 'SUSPENSO'].includes(f.status_qualificacao)) return res.status(400).json({ message: 'Só fornecedor qualificado (ou suspenso) passa por requalificação.' });
      }
      if (tipo === 'REATIVACAO' && f.status_qualificacao !== 'REPROVADO') return res.status(400).json({ message: 'Reativação por nova qualificação é para fornecedor reprovado.' });
      if (tipo !== 'INICIAL' && !Q.nul(b.motivo) && tipo !== 'REQUALIFICACAO') return res.status(400).json({ message: 'Informe o motivo.' });
      const u = Q.usuario(req);
      let proc;
      try {
        [proc] = await Pg.connectAndQuery(
          `INSERT INTO tab_qf_qualificacao (fornecedor_id, tipo, etapa, criticidade_definida, vencimento_anterior, motivo, iniciado_por, atualizado_por)
           VALUES (@f, @t, @etapa, @crit, @venc, @m, @u, @u) RETURNING *`,
          { f: id, t: tipo, etapa: tipo === 'REQUALIFICACAO' ? 'FORM_7328' : 'CRITICIDADE', crit: tipo === 'REQUALIFICACAO',
            venc: tipo === 'REQUALIFICACAO' ? f.qualificacao_valida_ate : null,
            m: Q.nul(b.motivo) || (tipo === 'REQUALIFICACAO' ? `Requalificação anual${f.qualificacao_valida_ate ? ' — vence em ' + new Date(f.qualificacao_valida_ate).toLocaleDateString('pt-BR') : ''}` : null), u: u.id });
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ message: 'Este fornecedor já tem um processo aberto.' });
        throw e;
      }
      if (tipo === 'REATIVACAO') {
        await Pg.connectAndQuery(`UPDATE tab_qf_fornecedor SET status_qualificacao = 'EM_QUALIFICACAO', ativo = TRUE, atualizado_por = @u, atualizado_em = NOW() WHERE id = @id`, { id, u: u.id });
      }
      await Q.log(Pg, req, { entidade: 'qualificacao', entidadeId: proc.id, fornecedorId: id, acao: 'INICIAR', mudancas: [{ campo: 'tipo', para: tipo }], motivo: proc.motivo });
      return res.json({ ok: true, processo: proc });
    } catch (err) { return Q.falha(res, 'abrir o processo', err); }
  }
});

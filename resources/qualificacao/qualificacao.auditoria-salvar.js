// POST /qualificacao/fornecedores/:id/auditorias — agenda/registra auditoria no
// fornecedor (segue o PRO 8.2.2). Com `id` no corpo, altera. O relatório vai em /anexos
// (entidade "auditoria", categoria RELATORIO). Perm 23004+ (Qualidade).
//
// motivo_tipo (PRO 7.3.7 item 5.6): INICIAL (5.6.1, na qualificação) | ACOMPANHAMENTO (5.6.2:
// IQF < 7 por 2 avaliações, 3+ NCs em 6 meses, ou antes de reativar suspenso) |
// REQUALIFICACAO (5.10). Sem informar: deduzido do processo aberto.
// Auditoria REALIZADA recalcula a sugestão de acompanhamento do fornecedor.

const Q = require('../../services/qfCore');

const data = (v) => { const s = Q.trim(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const CAMPOS = ['qualificacao_id', 'motivo_tipo', 'tipo', 'status', 'data_agendada', 'data_realizada', 'auditor_id', 'auditor_nome', 'escopo', 'resultado', 'plano_acao', 'referencia_pro_822', 'observacoes'];

module.exports = (app) => ({
  verb: 'post',
  route: '/fornecedores/:id/auditorias',
  middlewares: [Q.mw(app, 'qualidade')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const fid = Number(req.params.id);
    const b = req.body || {};
    try {
      const [f] = await Pg.connectAndQuery(`SELECT id, status_qualificacao FROM tab_qf_fornecedor WHERE id = @id`, { id: fid });
      if (!f) return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      const [proc] = await Pg.connectAndQuery(`SELECT id, tipo FROM tab_qf_qualificacao WHERE fornecedor_id = @id AND status IN ('EM_ANDAMENTO','PAUSADO') ORDER BY id DESC LIMIT 1`, { id: fid });
      const d = {
        qualificacao_id: b.qualificacao_id ? Number(b.qualificacao_id) : (proc ? proc.id : null),
        motivo_tipo: ['INICIAL', 'ACOMPANHAMENTO', 'REQUALIFICACAO'].includes(b.motivo_tipo) ? b.motivo_tipo
          : proc && proc.tipo === 'REQUALIFICACAO' ? 'REQUALIFICACAO' : proc ? 'INICIAL' : 'ACOMPANHAMENTO',
        tipo: ['IN_LOCO', 'REMOTA', 'DOCUMENTAL'].includes(b.tipo) ? b.tipo : null,
        status: ['AGENDADA', 'REALIZADA', 'CANCELADA'].includes(b.status) ? b.status : 'AGENDADA',
        data_agendada: data(b.data_agendada), data_realizada: data(b.data_realizada),
        auditor_id: b.auditor_id ? Number(b.auditor_id) : null, auditor_nome: Q.nul(b.auditor_nome),
        escopo: Q.nul(b.escopo),
        resultado: ['CONFORME', 'NAO_CONFORME', 'CONFORME_COM_OBSERVACOES'].includes(b.resultado) ? b.resultado : null,
        plano_acao: Q.nul(b.plano_acao), referencia_pro_822: b.referencia_pro_822 !== false, observacoes: Q.nul(b.observacoes)
      };
      if (!d.tipo) return res.status(400).json({ message: 'Informe o tipo (in loco, remota ou documental).' });
      if (d.status === 'AGENDADA' && !d.data_agendada) return res.status(400).json({ message: 'Informe a data agendada.' });
      if (d.status === 'REALIZADA' && (!d.data_realizada || !d.resultado)) return res.status(400).json({ message: 'Auditoria realizada exige data de realização e resultado.' });
      if (d.status === 'REALIZADA' && d.resultado === 'NAO_CONFORME' && !d.plano_acao && !d.observacoes) return res.status(400).json({ message: 'Auditoria não conforme: registre as constatações (observações) ou o plano de ação solicitado ao fornecedor.' });
      if (d.status === 'REALIZADA' && d.data_realizada > new Date().toISOString().slice(0, 10)) return res.status(400).json({ message: 'A data de realização não pode ser futura.' });
      if (d.status === 'CANCELADA' && !Q.nul(b.motivo)) return res.status(400).json({ message: 'Informe o motivo do cancelamento.' });
      const u = Q.usuario(req);
      let a;
      if (b.id) {
        const [antes] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_auditoria WHERE id = @id AND fornecedor_id = @f`, { id: Number(b.id), f: fid });
        if (!antes) return res.status(404).json({ message: 'Auditoria não encontrada.' });
        [a] = await Pg.connectAndQuery(
          `UPDATE tab_qf_auditoria SET ${CAMPOS.map(c => `${c} = @${c}`).join(', ')}, atualizado_por = @u, atualizado_em = NOW() WHERE id = @id RETURNING *`,
          { ...d, u: u.id, id: antes.id });
        await Q.log(Pg, req, { entidade: 'auditoria', entidadeId: a.id, fornecedorId: fid, acao: 'ALTERAR', mudancas: Q.diff(antes, a, CAMPOS), motivo: b.motivo });
      } else {
        [a] = await Pg.connectAndQuery(
          `INSERT INTO tab_qf_auditoria (fornecedor_id, ${CAMPOS.join(', ')}, criado_por, atualizado_por)
           VALUES (@f, ${CAMPOS.map(c => '@' + c).join(', ')}, @u, @u) RETURNING *`, { ...d, f: fid, u: u.id });
        await Q.log(Pg, req, { entidade: 'auditoria', entidadeId: a.id, fornecedorId: fid, acao: 'CRIAR', mudancas: [{ campo: 'motivo_tipo', para: d.motivo_tipo }, { campo: 'tipo', para: d.tipo }, { campo: 'status', para: d.status }] });
      }
      if (d.status === 'REALIZADA') await Q.recalcularFornecedor(app, fid, { req, semAcoes: true });
      return res.json({ ok: true, auditoria: a });
    } catch (err) { return Q.falha(res, 'salvar a auditoria', err); }
  }
});

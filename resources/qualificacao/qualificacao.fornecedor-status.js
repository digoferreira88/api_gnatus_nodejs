// POST /qualificacao/fornecedores/:id/status — suspender / reativar / inativar.
// Perm 23003+ (Engenharia: "monitorar fornecedores aprovados e tomar ações" — PRO 4.1).
// Sempre com motivo; tudo vai para a trilha.
//
// body: { acao: SUSPENDER | REATIVAR | INATIVAR | ATIVAR, motivo, status?, dispensarAuditoria?, justificativaAuditoria? }
//   REATIVAR (só de SUSPENSO):
//     - bloqueio por plano de ação (classe C/D): libera-se registrando o plano (PUT /plano-iqf);
//     - suspensão por requalificação vencida: libera-se aprovando o FORM 7.3.28;
//     - suspensão por documento: só com o documento regularizado;
//     - classe C/D sem plano de ação registrado: registra-se o plano antes;
//     - demais: PRO 5.6.2 pede auditoria de acompanhamento ANTES da reativação — exige uma
//       auditoria realizada (conforme) depois da suspensão, ou a dispensa justificada.
//   REPROVADO não se reativa aqui: abre-se nova qualificação.
//   INATIVAR/ATIVAR: tira/volta o fornecedor das listas e do recebimento.

const Q = require('../../services/qfCore');
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'post',
  route: '/fornecedores/:id/status',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    const b = req.body || {};
    const acao = Q.trim(b.acao).toUpperCase();
    const motivo = Q.nul(b.motivo);
    if (!motivo) return res.status(400).json({ message: 'Informe o motivo.' });
    try {
      const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id });
      if (!f) return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      const u = Q.usuario(req);

      if (acao === 'SUSPENDER') {
        if (f.status_qualificacao === 'SUSPENSO') return res.status(409).json({ message: 'Fornecedor já está suspenso.' });
        await Q.suspender(app, f, motivo, req, 'MANUAL', 'MANUAL');
      } else if (acao === 'REATIVAR') {
        if (f.status_qualificacao !== 'SUSPENSO') return res.status(409).json({ message: f.status_qualificacao === 'REPROVADO' ? 'Fornecedor reprovado só volta por um novo processo de qualificação.' : 'Só fornecedor suspenso pode ser reativado.' });
        if (Q.TIPOS_PLANO.includes(f.suspensao_tipo)) return res.status(409).json({ message: 'Bloqueio por classe C/D: libere registrando o plano de ação do fornecedor (com o anexo).', plano: true });
        if (f.suspensao_tipo === 'REQUALIFICACAO') return res.status(409).json({ message: 'Suspensão por requalificação vencida: libera-se ao aprovar o FORM 7.3.28 da requalificação.', requalificacao: true });
        if (['C', 'D'].includes(f.classificacao) && !f.plano_acao_iqf) return res.status(409).json({ message: `Fornecedor na classe ${f.classificacao} sem plano de ação registrado: registre o plano (com o anexo) antes de reativar.`, plano: true });
        if (f.suspensao_tipo === 'DOCUMENTO') {
          const ck = await Q.checklistFornecedor(Pg, f);
          if (ck.vencidos > 0) return res.status(409).json({ message: `Suspensão por documento: ainda há ${ck.vencidos} documento(s) vencido(s) — registre o documento atualizado (ou o protocolo, com prazo) antes de reativar.`, documentos: true });
        }
        const [aud] = await Pg.connectAndQuery(
          `SELECT id, data_realizada FROM tab_qf_auditoria WHERE fornecedor_id = @id AND status = 'REALIZADA'
              AND resultado IN ('CONFORME','CONFORME_COM_OBSERVACOES') AND data_realizada >= @desde::date ORDER BY data_realizada DESC LIMIT 1`,
          { id, desde: f.suspenso_em || '1900-01-01' });
        const dispensa = b.dispensarAuditoria === true ? Q.nul(b.justificativaAuditoria) : null;
        if (!aud && !dispensa) {
          return res.status(400).json({ message: 'PRO 7.3.7 item 5.6.2: reativação de fornecedor suspenso exige auditoria de acompanhamento realizada depois da suspensão — registre a auditoria, ou dispense com justificativa.', auditoria: true });
        }
        const [ult] = await Pg.connectAndQuery(`SELECT aprovacao_resultado FROM tab_qf_qualificacao WHERE fornecedor_id = @id AND status = 'APROVADO' ORDER BY aprovacao_em DESC NULLS LAST LIMIT 1`, { id });
        const destino = ['APROVADO', 'APROVADO_COM_RESTRICAO'].includes(b.status) ? b.status
          : ult && /COM_RESTRICAO$/.test(ult.aprovacao_resultado || '') ? 'APROVADO_COM_RESTRICAO' : 'APROVADO';
        await Pg.connectAndQuery(
          `UPDATE tab_qf_fornecedor SET status_qualificacao = @st, suspensao_tipo = NULL, motivo_suspensao = NULL, suspenso_em = NULL, atualizado_por = @u, atualizado_em = NOW() WHERE id = @id`,
          { st: destino, u: u.id, id });
        await Q.log(Pg, req, { entidade: 'fornecedor', entidadeId: id, fornecedorId: id, acao: 'REATIVAR',
          mudancas: [{ campo: 'status_qualificacao', de: f.status_qualificacao, para: destino }, { campo: 'suspensao_tipo', de: f.suspensao_tipo, para: null },
            aud ? { campo: 'auditoria_acompanhamento', para: `auditoria ${aud.id} de ${String(aud.data_realizada).slice(0, 10)}` } : { campo: 'auditoria_dispensada', para: dispensa }], motivo });
        await avisarLiberacao(app, f, motivo);
      } else if (acao === 'INATIVAR' || acao === 'ATIVAR') {
        const ativo = acao === 'ATIVAR';
        if (f.ativo === ativo) return res.status(409).json({ message: ativo ? 'Fornecedor já está ativo.' : 'Fornecedor já está inativo.' });
        await Pg.connectAndQuery(`UPDATE tab_qf_fornecedor SET ativo = @a, atualizado_por = @u, atualizado_em = NOW() WHERE id = @id`, { a: ativo, u: u.id, id });
        await Q.log(Pg, req, { entidade: 'fornecedor', entidadeId: id, fornecedorId: id, acao, mudancas: [{ campo: 'ativo', de: f.ativo, para: ativo }], motivo });
      } else {
        return res.status(400).json({ message: 'Ação inválida.' });
      }

      Auditoria.registrar(app, {
        modulo: 'Qualidade', submodulo: 'Qualificação de Fornecedores', acao, severidade: acao === 'SUSPENDER' ? 'ALERTA' : 'AVISO', req,
        entidade: 'fornecedor', entidadeId: String(id), descricao: `${acao} ${f.codigo} – ${f.razao_social}: ${motivo}`
      });
      const [depois] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id });
      return res.json({ ok: true, fornecedor: depois });
    } catch (err) { return Q.falha(res, 'alterar a situação do fornecedor', err); }
  }
});

async function avisarLiberacao(app, f, motivo) {
  const cfg = await Q.config(app.services.Pg);
  await Q.notificar(app, {
    chave: `liberacao|${f.id}|${Date.now()}`, tipo: 'LIBERACAO', entidade: 'fornecedor', entidadeId: f.id, fornecedorId: f.id,
    para: [...cfg.emails_engenharia, ...cfg.emails_qualidade], assunto: `[Liberar no Protheus] ${f.codigo} – ${f.razao_social}`,
    texto: `O fornecedor ${f.codigo} – ${f.razao_social} foi reativado no módulo de Qualificação de Fornecedores.\nMotivo: ${motivo}\n\nProvidência: reativar o fornecedor no Protheus (cadastro SA2), se estiver bloqueado.`
  });
}
module.exports.avisarLiberacao = avisarLiberacao;

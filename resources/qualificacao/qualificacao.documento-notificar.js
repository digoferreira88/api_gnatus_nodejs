// POST /qualificacao/fornecedores/:id/notificar-documento — "notificar em um clique":
// pede ao fornecedor o documento vencido/vencendo/pendente. Perm 23003+ (Engenharia —
// quem conduz a qualificação e controla os documentos, PRO 4.1).
// body: { tipoId, email? (sobrepõe o contato do cadastro), mensagem? }
//
// E-mail ao fornecedor é EXTERNO: só sai com a chave "email_fornecedor" ligada na
// Configuração. Desligada, a notificação fica registrada como não enviada e a tela
// mostra o texto para a Engenharia mandar pelo próprio e-mail.

const Q = require('../../services/qfCore');

module.exports = (app) => ({
  verb: 'post',
  route: '/fornecedores/:id/notificar-documento',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    const b = req.body || {};
    try {
      const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id });
      if (!f) return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      const [tipo] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_tipo_documento WHERE id = @t`, { t: Number(b.tipoId) || 0 });
      if (!tipo) return res.status(400).json({ message: 'Tipo de documento inválido.' });
      const email = Q.trim(b.email) || f.contato_email;
      if (!email) return res.status(400).json({ message: 'O fornecedor não tem e-mail de contato. Informe um e-mail.' });
      const [doc] = await Pg.connectAndQuery(
        `SELECT * FROM tab_qf_documento WHERE fornecedor_id = @f AND tipo_documento_id = @t AND status IN ('VIGENTE','PROTOCOLADO') ORDER BY enviado_em DESC LIMIT 1`,
        { f: id, t: tipo.id });
      const fmt = (d) => new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
      const venc = doc && doc.status === 'PROTOCOLADO' && doc.prazo_regularizacao ? `apresentado por protocolo, com prazo para o documento definitivo em ${fmt(doc.prazo_regularizacao)}`
        : doc && doc.data_validade ? `o documento em nosso cadastro tem validade em ${fmt(doc.data_validade)}` : null;
      const texto = [
        'Prezado fornecedor,', '',
        `Para manter ${f.razao_social} qualificado como fornecedor da GNATUS, solicitamos o envio do documento:`,
        `  • ${tipo.nome}${venc ? ` (${venc})` : ''}`, '',
        Q.trim(b.mensagem) || 'Por favor, responda a este e-mail com o documento atualizado ou o protocolo de renovação.', '',
        'Atenciosamente,', 'Engenharia — GNATUS'
      ].join('\n');
      const r = await Q.notificar(app, {
        chave: `doc_manual|${id}|${tipo.id}|${Date.now()}`, tipo: 'DOCUMENTO_SOLICITADO', entidade: 'fornecedor', entidadeId: id, fornecedorId: id,
        para: [email], externo: true, assunto: `GNATUS — documento de qualificação: ${tipo.nome}`, texto
      });
      await Q.log(Pg, req, { entidade: 'fornecedor', entidadeId: id, fornecedorId: id, acao: 'SOLICITAR_DOCUMENTO',
        mudancas: [{ campo: 'tipo', para: tipo.codigo }, { campo: 'para', para: email }, { campo: 'enviado', para: r.enviado ? 'sim' : `não (${r.erro})` }] });
      return res.json({ ok: true, enviado: !!r.enviado, motivo: r.erro || null, para: email, assunto: `GNATUS — documento de qualificação: ${tipo.nome}`, texto });
    } catch (err) { return Q.falha(res, 'notificar o fornecedor', err); }
  }
});

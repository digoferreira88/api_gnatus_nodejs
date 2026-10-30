// POST /qualificacao/fornecedores/:id/fichas — gera o link para o FORNECEDOR preencher, sem
// login, o FORM 7.3.21 (cadastro, documentação e questionário — qualificação) ou o FORM 7.3.28
// (requalificação anual). Se já houver ficha em aberto do mesmo formulário no processo, renova o
// link dela (reenvio). Perm 23003+ (Engenharia: "solicitar o preenchimento" — PRO 4.1).
//
// body: { formulario?: '7.3.21' | '7.3.28', email?, enviarEmail? } — o e-mail ao fornecedor só
// sai com a chave "email_fornecedor" ligada; de qualquer forma o link volta para ser copiado.

const crypto = require('crypto');
const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');

module.exports = (app) => ({
  verb: 'post',
  route: '/fornecedores/:id/fichas',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    const b = req.body || {};
    const formulario = b.formulario === '7.3.28' ? '7.3.28' : '7.3.21';
    try {
      const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id });
      if (!f) return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      const [proc] = await Pg.connectAndQuery(
        `SELECT id, tipo FROM tab_qf_qualificacao WHERE fornecedor_id = @id AND status IN ('EM_ANDAMENTO','PAUSADO') ORDER BY id DESC LIMIT 1`, { id });
      if (formulario === '7.3.28' && (!proc || proc.tipo !== 'REQUALIFICACAO')) {
        return res.status(400).json({ message: 'O FORM 7.3.28 é enviado dentro de uma requalificação — abra a requalificação do fornecedor primeiro.' });
      }
      let perguntas = 0;
      if (formulario === '7.3.21') {
        perguntas = R.perguntasAplicaveis(await Pg.connectAndQuery(`SELECT * FROM tab_qf_pergunta WHERE ativo`), f.criticidades).length;
        if (!perguntas) return res.status(400).json({ message: 'Nenhuma pergunta do FORM 7.3.21 ativa. Confira em Configuração → Questionário.' });
      }
      const cfg = await Q.config(Pg);
      const u = Q.usuario(req);
      const email = Q.trim(b.email) || f.contato_email || null;
      const token = crypto.randomBytes(24).toString('hex');
      const expira = new Date(Date.now() + cfg.questionario_validade_dias * 86400000);

      const [aberta] = await Pg.connectAndQuery(
        `SELECT * FROM tab_qf_ficha WHERE fornecedor_id = @id AND formulario = @form AND status IN ('RASCUNHO','ENVIADA','DEVOLVIDA')
            AND (qualificacao_id IS NOT DISTINCT FROM @proc) ORDER BY id DESC LIMIT 1`, { id, form: formulario, proc: proc ? proc.id : null });
      let ficha;
      if (aberta) {
        [ficha] = await Pg.connectAndQuery(
          `UPDATE tab_qf_ficha SET token = @tk, token_expira_em = @exp, enviada_em = NOW(), enviada_para = @email, enviada_por = @u,
                  status = CASE WHEN status = 'RASCUNHO' THEN 'ENVIADA' ELSE status END, atualizado_em = NOW()
            WHERE id = @fid RETURNING *`, { tk: token, exp: expira, email, u: u.id, fid: aberta.id });
      } else {
        [ficha] = await Pg.connectAndQuery(
          `INSERT INTO tab_qf_ficha (fornecedor_id, qualificacao_id, formulario, status, token, token_expira_em, enviada_em, enviada_para, enviada_por, criado_por)
           VALUES (@f, @proc, @form, 'ENVIADA', @tk, @exp, NOW(), @email, @u, @u) RETURNING *`,
          { f: id, proc: proc ? proc.id : null, form: formulario, tk: token, exp: expira, email, u: u.id });
      }
      const link = `${Q.BASE_URL()}/questionario-fornecedor/${token}`;
      const titulo = formulario === '7.3.28' ? 'Requalificação de Fornecedores (FORM 7.3.28)' : 'Cadastro e Avaliação de Fornecedores (FORM 7.3.21)';
      let envio = { enviado: false, erro: 'não solicitado' };
      if (b.enviarEmail && email) {
        envio = await Q.notificar(app, {
          chave: `ficha|${ficha.id}|${token.slice(0, 8)}`, tipo: formulario === '7.3.28' ? 'REQUALIFICACAO_ENVIADA' : 'QUESTIONARIO_ENVIADO', entidade: 'ficha', entidadeId: ficha.id, fornecedorId: id,
          para: [email], externo: true, assunto: `GNATUS — ${titulo}`,
          texto: formulario === '7.3.28'
            ? `Prezado fornecedor,\n\nÉ hora da requalificação anual de ${f.razao_social} como fornecedor da GNATUS. Confirme ou atualize seus dados cadastrais, informe as alterações do período e envie os documentos vencidos ou alterados pelo link abaixo (não precisa de login):\n\n${link}\n\nO link vale até ${expira.toLocaleDateString('pt-BR')}.\n\nAtenciosamente,\nEngenharia — GNATUS`
            : `Prezado fornecedor,\n\nPara a qualificação de ${f.razao_social} como fornecedor da GNATUS, pedimos que preencha o cadastro, a documentação e o questionário de avaliação pelo link abaixo (não precisa de login):\n\n${link}\n\nO link vale até ${expira.toLocaleDateString('pt-BR')}. Marque UMA alternativa por requisito e informe a comprovação; requisito deixado em branco é considerado NÃO.\n\nAtenciosamente,\nEngenharia — GNATUS`
        });
      }
      await Q.log(Pg, req, { entidade: 'ficha', entidadeId: ficha.id, fornecedorId: id, acao: aberta ? 'REENVIAR' : 'CRIAR',
        mudancas: [{ campo: 'formulario', para: formulario }, { campo: 'enviada_para', para: email }, { campo: 'expira', para: expira.toISOString().slice(0, 10) }, { campo: 'email_enviado', para: envio.enviado ? 'sim' : `não (${envio.erro})` }] });
      return res.json({ ok: true, ficha: { ...ficha, token: undefined }, link, expira, email: { enviado: !!envio.enviado, motivo: envio.erro || null }, perguntas });
    } catch (err) { return Q.falha(res, 'gerar o formulário', err); }
  }
});

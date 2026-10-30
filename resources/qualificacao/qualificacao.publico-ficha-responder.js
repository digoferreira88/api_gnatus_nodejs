// POST /qualificacao/publico/ficha/:token — o FORNECEDOR envia o FORM 7.3.21 ou 7.3.28
// (sem login). Exige a declaração aceita (assinatura eletrônica do fornecedor), nome e e-mail
// de quem responde. Avisa a Qualidade (7.3.21 aguardando avaliação) ou a Engenharia (7.3.28).
// ANÔNIMO, com limite por IP.

const rateLimit = require('express-rate-limit');
const Q = require('../../services/qfCore');
const { ErroFicha, gravarRespostas } = require('../../services/qfFicha');

const limitador = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { message: 'Muitas tentativas. Tente em alguns minutos.' } });

module.exports = (app) => ({
  verb: 'post',
  route: '/publico/ficha/:token',
  anonymous: true,
  middlewares: [limitador],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const token = Q.trim(req.params.token);
    const b = req.body || {};
    if (!/^[0-9a-f]{48}$/.test(token)) return res.status(404).json({ message: 'Link inválido.' });
    try {
      const [ficha] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_ficha WHERE token = @t`, { t: token });
      if (!ficha) return res.status(404).json({ message: 'Link inválido ou já utilizado.' });
      if (ficha.token_expira_em && new Date(ficha.token_expira_em) < new Date()) return res.status(410).json({ message: 'Este link expirou. Peça um novo à Engenharia da GNATUS.' });
      if (!Q.trim(b.respondente_nome) || !/.+@.+\..+/.test(Q.trim(b.respondente_email))) {
        return res.status(400).json({ message: 'Informe o nome e o e-mail de quem está respondendo.' });
      }
      const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id: ficha.fornecedor_id });
      const r = await gravarRespostas(Pg, ficha, f, b, { ip: Q.ipDe(req), exigirAceite: true });
      await Q.log(Pg, null, { entidade: 'ficha', entidadeId: ficha.id, fornecedorId: f.id, acao: 'RESPONDER',
        mudancas: [{ campo: 'formulario', para: ficha.formulario }, { campo: 'respondente', para: `${Q.trim(b.respondente_nome)} <${Q.trim(b.respondente_email)}>` },
          { campo: 'assinatura', para: 'declaração aceita pelo fornecedor' }, { campo: 'respostas', para: r.respostas }, { campo: 'em_branco', para: r.emBranco }],
        motivo: `link público · IP ${Q.ipDe(req) || '—'}` });
      const cfg = await Q.config(Pg);
      const eh7321 = ficha.formulario === '7.3.21';
      await Q.notificar(app, {
        chave: `ficha_respondida|${ficha.id}|${Date.now()}`, tipo: eh7321 ? 'QUESTIONARIO_RECEBIDO' : 'REQUALIFICACAO_RECEBIDA', entidade: 'ficha', entidadeId: ficha.id, fornecedorId: f.id,
        para: eh7321 ? [...cfg.emails_qualidade, ...cfg.emails_engenharia] : cfg.emails_engenharia,
        assunto: eh7321 ? `[FORM 7.3.21 recebido] ${f.codigo} – ${f.razao_social} aguarda avaliação` : `[FORM 7.3.28 recebido] ${f.codigo} – ${f.razao_social}`,
        texto: eh7321
          ? `O fornecedor ${f.codigo} – ${f.razao_social} enviou o FORM 7.3.21 (${r.respostas} requisitos, ${r.emBranco} em branco = NÃO; prévia ${r.placar ? r.placar.percentual : '—'}%; ${r.documentos} documento(s) declarados).\nRespondido por ${Q.trim(b.respondente_nome)} <${Q.trim(b.respondente_email)}>.\nAvaliação crítica do questionário: Garantia da Qualidade.`
          : `O fornecedor ${f.codigo} – ${f.razao_social} devolveu o FORM 7.3.28 (requalificação). Respondido por ${Q.trim(b.respondente_nome)} <${Q.trim(b.respondente_email)}>.\nSiga com a análise documental, de desempenho e das alterações declaradas.`
      });
      return res.json({ ok: true, emBranco: r.emBranco, mensagem: 'Formulário enviado. Obrigado! A GNATUS fará a análise e entrará em contato.' });
    } catch (err) {
      if (err instanceof ErroFicha) return res.status(err.status).json({ message: err.message, erros: err.erros });
      return Q.falha(res, 'enviar o formulário', err);
    }
  }
});

// POST /qualificacao/fichas/:fid/analisar — avaliação crítica do questionário do FORM 7.3.21
// pela Garantia da Qualidade (PRO 4.2 / 5.5). DEVOLVER também vale para o FORM 7.3.28
// (Engenharia). Perm 23003+; ANALISAR exige 23004+ (Qualidade).
//
// body: { acao: ANALISAR | DEVOLVER, parecer?, plano_acao?, motivo? }
//   ANALISAR: pontua com a regra vigente → APROVADO (≥70%) | APROVADO_COM_RESTRICAO
//             (50–69,99%, exige plano de ação) | REPROVADO (<50%: encerra o processo e
//             marca o fornecedor como REPROVADO — PRO 7.3.7).
//   DEVOLVER: questionário inválido/incompleto volta ao fornecedor com o motivo; o link
//             é renovado.

const crypto = require('crypto');
const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');

module.exports = (app) => ({
  verb: 'post',
  route: '/fichas/:fid/analisar',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const fid = Number(req.params.fid);
    const b = req.body || {};
    const acao = Q.trim(b.acao).toUpperCase();
    try {
      const [ficha] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_ficha WHERE id = @id`, { id: fid });
      if (!ficha) return res.status(404).json({ message: 'Ficha não encontrada.' });
      const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id: ficha.fornecedor_id });
      const u = Q.usuario(req);
      const cfg = await Q.config(Pg);
      const niveis = await Q.niveisDoUsuario(Pg, req);
      if (acao === 'ANALISAR' && !niveis.qualidade) return res.status(403).json({ message: 'A avaliação crítica do questionário é da Garantia da Qualidade (PRO 7.3.7 item 4.2).' });
      if (acao === 'ANALISAR' && ficha.formulario !== '7.3.21') return res.status(400).json({ message: 'O FORM 7.3.28 é analisado nas etapas da requalificação.' });
      if (acao === 'DEVOLVER' && ficha.formulario === '7.3.21' && !niveis.qualidade) return res.status(403).json({ message: 'Devolver o questionário é decisão da Garantia da Qualidade.' });

      if (acao === 'DEVOLVER') {
        if (!['RESPONDIDA', 'ENVIADA'].includes(ficha.status)) return res.status(409).json({ message: 'Só ficha respondida/enviada pode ser devolvida.' });
        const motivo = Q.nul(b.motivo);
        if (!motivo) return res.status(400).json({ message: 'Explique ao fornecedor o que precisa ser corrigido.' });
        const token = crypto.randomBytes(24).toString('hex');
        const expira = new Date(Date.now() + cfg.questionario_validade_dias * 86400000);
        await Pg.connectAndQuery(
          `UPDATE tab_qf_ficha SET status = 'DEVOLVIDA', devolvida_motivo = @m, token = @tk, token_expira_em = @exp, atualizado_em = NOW() WHERE id = @id`,
          { m: motivo, tk: token, exp: expira, id: fid });
        const link = `${Q.BASE_URL()}/questionario-fornecedor/${token}`;
        const para = ficha.respondente_email || ficha.enviada_para || f.contato_email;
        const envio = para ? await Q.notificar(app, {
          chave: `ficha_devolvida|${fid}|${token.slice(0, 8)}`, tipo: 'QUESTIONARIO_DEVOLVIDO', entidade: 'ficha', entidadeId: fid, fornecedorId: f.id,
          para: [para], externo: true, assunto: 'GNATUS — questionário de fornecedor devolvido para correção',
          texto: `Prezado fornecedor,\n\nO questionário de avaliação de ${f.razao_social} precisa de correção:\n\n${motivo}\n\nCorrija pelo link (válido até ${expira.toLocaleDateString('pt-BR')}):\n${link}\n\nAtenciosamente,\nGarantia da Qualidade — GNATUS`
        }) : { enviado: false, erro: 'sem e-mail do fornecedor' };
        await Q.log(Pg, req, { entidade: 'ficha', entidadeId: fid, fornecedorId: f.id, acao: 'DEVOLVER', mudancas: [{ campo: 'status', de: ficha.status, para: 'DEVOLVIDA' }], motivo });
        return res.json({ ok: true, status: 'DEVOLVIDA', link, email: { enviado: !!envio.enviado, motivo: envio.erro || null } });
      }

      if (acao !== 'ANALISAR') return res.status(400).json({ message: 'Ação inválida.' });
      if (ficha.status !== 'RESPONDIDA') return res.status(409).json({ message: 'A ficha precisa estar respondida para ser analisada.' });
      const respostas = await Pg.connectAndQuery(`SELECT pergunta_id, pergunta_secao, alternativa FROM tab_qf_resposta WHERE ficha_id = @id`, { id: fid });
      if (!respostas.length) return res.status(400).json({ message: 'Ficha sem respostas.' });
      const regra = await Q.regraAtiva(Pg);
      const placar = R.pontuarQuestionario(regra.conteudo, respostas);   // em branco já gravado como NÃO
      const plano = Q.nul(b.plano_acao);
      if (placar.resultado === 'APROVADO_COM_RESTRICAO' && !plano) {
        return res.status(400).json({ message: `Pontuação ${placar.percentual}%: aprovado com restrição exige plano de ação.`, placar });
      }
      await Q.tx(Pg, async (q) => {
        await q(`UPDATE tab_qf_ficha SET status = 'ANALISADA', resultado = @res, pontuacao_total = @tot, pontuacao_maxima = @max,
                   pontuacao_percentual = @pct, por_secao = @sec::jsonb, regra_versao_id = @rg, analisada_em = NOW(), analisada_por = @u, parecer = @par,
                   plano_acao = @plano, token = NULL, atualizado_em = NOW()
                 WHERE id = @id`,
          { res: placar.resultado, tot: placar.total, max: placar.maximo, pct: placar.percentual, sec: JSON.stringify(placar.porSecao), rg: regra.id, u: u.id, par: Q.nul(b.parecer), plano, id: fid });
        await Q.log(Pg, req, { entidade: 'ficha', entidadeId: fid, fornecedorId: f.id, acao: 'ANALISAR',
          mudancas: [{ campo: 'resultado', para: placar.resultado }, { campo: 'pontuacao_percentual', para: placar.percentual }], motivo: Q.nul(b.parecer) }, q);
        const [proc] = ficha.qualificacao_id ? await q(`SELECT tipo FROM tab_qf_qualificacao WHERE id = @id`, { id: ficha.qualificacao_id }) : [null];
        // reprovado na qualificação inicial: "não poderá seguir com a qualificação" (PRO 5.5).
        // Na requalificação o resultado vai para a análise do FORM 7.3.28 (gerente decide).
        if (placar.resultado === 'REPROVADO' && (!proc || proc.tipo !== 'REQUALIFICACAO')) {
          // fluxo encerrado (PRO 7.3.7): processo e fornecedor reprovados
          if (ficha.qualificacao_id) {
            await q(`UPDATE tab_qf_qualificacao SET status = 'REPROVADO', etapa = 'CONCLUIDO', concluido_em = NOW(), aprovacao_resultado = 'REPROVADO',
                       motivo = @m, atualizado_por = @u, atualizado_em = NOW() WHERE id = @id AND status IN ('EM_ANDAMENTO','PAUSADO')`,
              { m: `Questionário reprovado (${placar.percentual}%)`, u: u.id, id: ficha.qualificacao_id });
          }
          await q(`UPDATE tab_qf_fornecedor SET status_qualificacao = 'REPROVADO', nota_sgq = @pct, sgq_questionario = 'SIM', atualizado_por = @u, atualizado_em = NOW() WHERE id = @f`,
            { pct: placar.percentual, u: u.id, f: f.id });
          await Q.log(Pg, req, { entidade: 'fornecedor', entidadeId: f.id, fornecedorId: f.id, acao: 'REPROVAR',
            mudancas: [{ campo: 'status_qualificacao', de: f.status_qualificacao, para: 'REPROVADO' }], motivo: `Questionário FORM 7.3.21 com ${placar.percentual}% (< ${regra.conteudo.questionario.restricao_min}%)` }, q);
        }
      });
      await Q.notificar(app, {
        chave: `ficha_analisada|${fid}`, tipo: 'QUESTIONARIO_ANALISADO', entidade: 'ficha', entidadeId: fid, fornecedorId: f.id,
        para: cfg.emails_engenharia, assunto: `[Qualificação] Questionário de ${f.codigo} – ${f.razao_social}: ${placar.resultado.replace(/_/g, ' ')} (${placar.percentual}%)`,
        texto: `A Qualidade analisou o FORM 7.3.21 de ${f.codigo} – ${f.razao_social}: ${placar.resultado.replace(/_/g, ' ')} com ${placar.percentual}%.${placar.resultado === 'REPROVADO' ? '\nO processo de qualificação foi encerrado e o fornecedor marcado como REPROVADO.' : ''}`
      });
      return res.json({ ok: true, ...placar });
    } catch (err) { return Q.falha(res, 'analisar o questionário', err); }
  }
});

// GET /qualificacao/fichas/:fid — formulário preenchido pelo fornecedor (FORM 7.3.21 ou
// 7.3.28): dados cadastrais, contatos, documentação declarada (com os arquivos enviados),
// questionário (retrato da época), pontuação por seção, alterações declaradas (7.3.28) e o
// link do fornecedor. Perm 23001+ (o link só para Engenharia+).

const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');
const F = require('../../services/qfFicha');

module.exports = (app) => ({
  verb: 'get',
  route: '/fichas/:fid',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const fid = Number(req.params.fid);
    try {
      const [ficha] = await Pg.connectAndQuery(
        `SELECT fi.*, ua.nome AS analisada_por_nome FROM tab_qf_ficha fi LEFT JOIN tab_intranet_usr ua ON ua.id = fi.analisada_por WHERE fi.id = @id`, { id: fid });
      if (!ficha) return res.status(404).json({ message: 'Ficha não encontrada.' });
      const [f] = await Pg.connectAndQuery(`SELECT id, codigo, razao_social, criticidades, nacional FROM tab_qf_fornecedor WHERE id = @id`, { id: ficha.fornecedor_id });
      const respostas = await Pg.connectAndQuery(`SELECT * FROM tab_qf_resposta WHERE ficha_id = @id ORDER BY id`, { id: fid });
      const todas = await Pg.connectAndQuery(`SELECT * FROM tab_qf_pergunta ORDER BY ordem, codigo`);
      const ajuda = new Map(todas.map(p => [p.id, p.ajuda]));
      const perguntas = ficha.formulario !== '7.3.21' ? []
        : respostas.length ? respostas.map(r => ({ id: r.pergunta_id, codigo: r.pergunta_codigo, secao: r.pergunta_secao, texto: r.pergunta_texto, ajuda: ajuda.get(r.pergunta_id) || null }))
        : R.perguntasAplicaveis(todas, f.criticidades).map(p => ({ id: p.id, codigo: p.codigo, secao: p.secao, texto: p.texto, ajuda: p.ajuda }));
      const regra = await Q.regraAtiva(Pg);
      const previa = respostas.length ? R.pontuarQuestionario(regra.conteudo, respostas.map(r => ({ perguntaId: r.pergunta_id, alternativa: r.alternativa })), perguntas) : null;
      const tipos = await Q.tiposDocumento(Pg);
      const anexos = await Pg.connectAndQuery(
        `SELECT id, nome_arquivo, mime_type, tamanho_bytes, descricao, enviado_em, enviado_por_externo FROM tab_qf_anexo
          WHERE entidade = 'ficha' AND entidade_id = @id AND NOT excluido ORDER BY id`, { id: fid });
      const registrados = await Pg.connectAndQuery(`SELECT anexo_id FROM tab_qf_documento WHERE anexo_id = ANY(@ids) AND status NOT IN ('EXCLUIDO')`, { ids: anexos.map(a => a.id) });
      const jaRegistrado = new Set(registrados.map(r => r.anexo_id));
      const docsDeclarados = ((ficha.dados || {}).documentos || []).map(d => {
        const t = tipos.find(x => x.id === d.tipoId);
        const a = anexos.find(x => x.id === d.anexoId);
        return { ...d, tipoNome: t ? t.nome : `#${d.tipoId}`, tipoCodigo: t ? t.codigo : null, exigeValidade: t ? t.exige_validade : false,
          anexo: a ? { id: a.id, nome_arquivo: a.nome_arquivo, tamanho_bytes: a.tamanho_bytes } : null, registrado: a ? jaRegistrado.has(a.id) : false };
      });
      const vigente = ficha.token && ficha.token_expira_em && new Date(ficha.token_expira_em) > new Date() && ['ENVIADA', 'DEVOLVIDA', 'RASCUNHO'].includes(ficha.status);
      const podeVerLink = (await Q.niveisDoUsuario(Pg, req)).engenharia;
      return res.json({
        ficha: { ...ficha, token: undefined },
        link: vigente && podeVerLink ? `${Q.BASE_URL()}/questionario-fornecedor/${ficha.token}` : null,
        fornecedor: f, perguntas, respostas, previa, documentosDeclarados: docsDeclarados, anexos,
        alteracoesRotulos: F.ALTERACOES_7328,
        faixas: regra.conteudo.questionario, pontos: regra.conteudo.pontos
      });
    } catch (err) { return Q.falha(res, 'carregar a ficha', err); }
  }
});

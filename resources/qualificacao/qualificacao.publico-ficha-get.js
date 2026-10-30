// GET /qualificacao/publico/ficha/:token — página do FORNECEDOR (sem login) para preencher o
// FORM 7.3.21 (cadastro, documentação, questionário) ou o FORM 7.3.28 (requalificação).
// Só devolve o necessário: razão social, campos pré-preenchidos, documentos aplicáveis à
// criticidade (com a situação atual, no 7.3.28), perguntas e o que já foi respondido. ANÔNIMO.

const rateLimit = require('express-rate-limit');
const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');
const F = require('../../services/qfFicha');

const limitador = rateLimit({ windowMs: 15 * 60 * 1000, max: 150, standardHeaders: true, legacyHeaders: false, message: { message: 'Muitas requisições. Tente em alguns minutos.' } });

module.exports = (app) => ({
  verb: 'get',
  route: '/publico/ficha/:token',
  anonymous: true,
  middlewares: [limitador],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const token = Q.trim(req.params.token);
    if (!/^[0-9a-f]{48}$/.test(token)) return res.status(404).json({ message: 'Link inválido.' });
    try {
      const [ficha] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_ficha WHERE token = @t`, { t: token });
      if (!ficha) return res.status(404).json({ message: 'Link inválido ou já utilizado.' });
      if (ficha.token_expira_em && new Date(ficha.token_expira_em) < new Date()) return res.status(410).json({ message: 'Este link expirou. Peça um novo à Engenharia da GNATUS.' });
      const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id: ficha.fornecedor_id });
      const tipos = await Q.tiposDocumento(Pg);
      const docs = await Pg.connectAndQuery(`SELECT * FROM tab_qf_documento WHERE fornecedor_id = @id`, { id: f.id });
      const ck = R.checklistDocumentos(tipos, docs, f, null);
      const documentos = ck.itens.filter(i => !i.geradoSistema).map(i => ({
        tipoId: i.tipoId, nome: i.nome, regra: i.regra, condicao: i.condicao, exigeValidade: i.exigeValidade,
        // no 7.3.28 o fornecedor vê o que está vencido/vencendo ("documentos válidos e sem alteração não precisam ser reenviados")
        situacaoAtual: ficha.formulario === '7.3.28' ? i.situacao : undefined,
        validadeAtual: ficha.formulario === '7.3.28' && i.documento ? i.documento.data_validade : undefined
      }));
      const perguntas = ficha.formulario === '7.3.21'
        ? R.perguntasAplicaveis(await Pg.connectAndQuery(`SELECT * FROM tab_qf_pergunta WHERE ativo ORDER BY ordem, codigo`), f.criticidades)
          .map(p => ({ id: p.id, codigo: p.codigo, secao: p.secao, texto: p.texto, ajuda: p.ajuda }))
        : [];
      const anteriores = await Pg.connectAndQuery(`SELECT pergunta_id, alternativa, em_branco, comprovacao FROM tab_qf_resposta WHERE ficha_id = @id`, { id: ficha.id });
      const anexos = await Pg.connectAndQuery(`SELECT id, nome_arquivo, tamanho_bytes, descricao FROM tab_qf_anexo WHERE entidade = 'ficha' AND entidade_id = @id AND NOT excluido ORDER BY id`, { id: ficha.id });
      const dados = ficha.dados && ficha.dados.cadastro ? ficha.dados : {
        cadastro: { razao_social: f.razao_social, nome_fantasia: f.nome_fantasia, cnpj: f.cnpj, endereco: f.endereco, cidade: f.cidade, estado: f.estado, cep: f.cep, telefone: f.contato_telefone },
        contatos: f.contato_nome || f.contato_email ? [{ nome: f.contato_nome, cargo: null, telefone: f.contato_telefone, email: f.contato_email }] : [],
        documentos: []
      };
      return res.json({
        formulario: ficha.formulario,
        fornecedor: f.razao_social,
        criticidades: R.normCriticidades(f.criticidades),
        nacional: f.nacional,
        status: ficha.status,
        podeResponder: ['RASCUNHO', 'ENVIADA', 'DEVOLVIDA', 'RESPONDIDA'].includes(ficha.status),
        devolvidaMotivo: ficha.status === 'DEVOLVIDA' ? ficha.devolvida_motivo : null,
        expira: ficha.token_expira_em,
        dados,
        respondente: { nome: ficha.respondente_nome, cargo: ficha.respondente_cargo, email: ficha.respondente_email },
        documentos,
        anexos,
        perguntas,
        respostas: anteriores.filter(a => !a.em_branco).map(a => ({ perguntaId: a.pergunta_id, alternativa: a.alternativa, comprovacao: a.comprovacao })),
        listas: { tiposEmpresa: F.TIPOS_EMPRESA, tiposFrete: F.TIPOS_FRETE, alteracoes: F.ALTERACOES_7328 },
        // texto da declaração: {empresa} = razão social informada no formulário
        declaracao: { versao: F.DECLARACAO.versao, modelo: F.DECLARACAO.texto }
      });
    } catch (err) { return Q.falha(res, 'abrir o formulário', err); }
  }
});

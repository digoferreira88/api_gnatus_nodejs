// GET /qualificacao/fornecedores/:id — ficha completa do fornecedor: cadastro,
// processo de qualificação ou requalificação (andamento das etapas), documentos (com
// histórico e os arquivos que o fornecedor mandou pelo link), formulários, auditorias,
// amostras, avaliações, IQF (geral e 12 meses), situação do recebimento, plano de ação
// (classes C/D), requalificação anual e auditoria de acompanhamento sugerida. Perm 23001+.

const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');
const P = require('../../services/qfProcesso');
const { situacaoRecebimento } = require('../../services/qfInspecao');

const anexosPlano = (anexos) => anexos.filter(a => a.entidade === 'fornecedor' && a.categoria === 'PLANO_ACAO');

module.exports = (app) => ({
  verb: 'get',
  route: '/fornecedores/:id',
  middlewares: [Q.mw(app, 'consulta')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id inválido.' });
    try {
      const ctx = await P.carregar(Pg, id, req.query.processoId || null);
      if (!ctx) return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      const regra = await Q.regraAtiva(Pg);
      const f = ctx.fornecedor;

      const documentos = await Pg.connectAndQuery(
        `SELECT d.*, t.codigo AS tipo_codigo, t.nome AS tipo_nome, a.nome_arquivo, a.tamanho_bytes,
                ue.nome AS enviado_por_nome, ua.nome AS aprovado_por_nome,
                a.enviado_por_externo,
                CASE WHEN d.status = 'PROTOCOLADO' AND d.prazo_regularizacao < CURRENT_DATE THEN 'PROTOCOLO_VENCIDO'
                     WHEN d.status = 'VIGENTE' AND d.data_validade < CURRENT_DATE THEN 'VENCIDO' ELSE d.status END AS situacao
           FROM tab_qf_documento d
           JOIN tab_qf_tipo_documento t ON t.id = d.tipo_documento_id
           LEFT JOIN tab_qf_anexo a ON a.id = d.anexo_id
           LEFT JOIN tab_intranet_usr ue ON ue.id = d.enviado_por
           LEFT JOIN tab_intranet_usr ua ON ua.id = d.aprovado_por
          WHERE d.fornecedor_id = @id
          ORDER BY t.ordem, d.enviado_em DESC`, { id });

      const anexos = await Pg.connectAndQuery(
        `SELECT a.id, a.entidade, a.entidade_id, a.categoria, a.nome_arquivo, a.mime_type, a.tamanho_bytes, a.descricao, a.enviado_em, u.nome AS enviado_por_nome,
                a.enviado_por_externo, (SELECT d.id FROM tab_qf_documento d WHERE d.anexo_id = a.id LIMIT 1) AS documento_id
           FROM tab_qf_anexo a LEFT JOIN tab_intranet_usr u ON u.id = a.enviado_por
          WHERE a.fornecedor_id = @id AND NOT a.excluido AND a.entidade <> 'documento'
          ORDER BY a.enviado_em DESC`, { id });

      const itensAval = ctx.avaliacoes.length ? await Pg.connectAndQuery(
        `SELECT * FROM tab_qf_avaliacao_item WHERE avaliacao_id = ANY(@ids) ORDER BY avaliacao_id, ordem, id`,
        { ids: ctx.avaliacoes.map(a => a.id) }) : [];

      const [doze] = await Pg.connectAndQuery(
        `SELECT AVG(iqf) media, COUNT(*)::int qtd, COUNT(*) FILTER (WHERE nc)::int ncs
           FROM tab_qf_inspecao WHERE fornecedor_id = @id AND NOT excluido AND iqf IS NOT NULL
            AND data_inspecao >= CURRENT_DATE - INTERVAL '12 months' AND data_inspecao <= CURRENT_DATE`, { id });
      const ultimas = await Pg.connectAndQuery(
        `SELECT id, rel_insp, data_inspecao, cod_item, nota_fiscal, pedido_compras, qtd_inspecionada, qtd_aprovada, qtd_reprovada,
                rnc_numero, indice_c, indice_p, indice_n, iqf, nc, responsavel_nome, origem, item_criticidade, tipo_prazo
           FROM tab_qf_inspecao WHERE fornecedor_id = @id AND NOT excluido
          ORDER BY data_inspecao DESC NULLS LAST, rel_insp DESC LIMIT 10`, { id });

      const perguntasAtivas = await Pg.connectAndQuery(`SELECT COUNT(*)::int n FROM tab_qf_pergunta WHERE ativo`);
      const niveis = await Q.niveisDoUsuario(Pg, req);
      const monit = R.monitorado(f);
      const [plano] = f.plano_acao_iqf_por ? await Pg.connectAndQuery(`SELECT nome FROM tab_intranet_usr WHERE id = @id`, { id: f.plano_acao_iqf_por }) : [null];
      const diasReq = f.qualificacao_valida_ate ? Math.round((new Date(String(f.qualificacao_valida_ate instanceof Date ? f.qualificacao_valida_ate.toISOString() : f.qualificacao_valida_ate).slice(0, 10)) - new Date(new Date().toISOString().slice(0, 10))) / 86400000) : null;

      return res.json({
        fornecedor: f,
        monitorado: monit,
        classe: monit ? R.classificar(regra.conteudo, f.iqf_medio) : null,
        iqf12m: { media: doze.qtd ? Q.r4(doze.media) : null, qtd: doze.qtd, ncs: doze.ncs, classe: monit ? R.classificar(regra.conteudo, doze.qtd ? doze.media : null) : null },
        recebimento: situacaoRecebimento(f, niveis),
        planoAcaoIqf: { aguardando: f.status_qualificacao === 'SUSPENSO' && Q.TIPOS_PLANO.includes(f.suspensao_tipo), texto: f.plano_acao_iqf, em: f.plano_acao_iqf_em, por: plano ? plano.nome : null,
          anexos: anexosPlano(anexos) },
        requalificacao: monit ? { validaAte: f.qualificacao_valida_ate, dias: diasReq, vencida: diasReq != null && diasReq < 0, semData: !f.qualificacao_valida_ate,
          processoAberto: ctx.processos.find(p => p.tipo === 'REQUALIFICACAO' && ['EM_ANDAMENTO', 'PAUSADO'].includes(p.status)) || null } : null,
        auditoriaSugerida: f.auditoria_sugerida_motivo || null,
        processo: ctx.processo,
        processos: ctx.processos,
        progresso: P.progresso(ctx),
        checklist: ctx.checklist,
        documentos,
        fichas: ctx.fichas.map(x => ({ ...x, token: undefined })),
        auditorias: ctx.auditorias,
        amostras: ctx.amostras,
        avaliacoes: ctx.avaliacoes.map(a => ({ ...a, itens: itensAval.filter(i => i.avaliacao_id === a.id) })),
        anexos,
        ultimasInspecoes: ultimas,
        perguntasCadastradas: perguntasAtivas[0].n,
        niveis
      });
    } catch (err) { return Q.falha(res, 'carregar o fornecedor', err); }
  }
});

// POST /qualificacao/processos/:pid/aprovar — aprovação do Gerente de Engenharia:
//   qualificação  → FORM 7.3.21 (APROVADO | APROVADO_COM_RESTRICAO | REPROVADO)
//   requalificação→ FORM 7.3.28 (REQUALIFICADO | REQUALIFICADO_COM_RESTRICAO | NAO_REQUALIFICADO)
// Perm 23005+.
//
// ASSINATURA ELETRÔNICA: senha da intranet reconfirmada no ato + declaração + SHA-256 do estado
// aprovado. Os pré-requisitos são os da tela (qfProcesso.progresso). Efeitos:
//   - aprovado/requalificado: validade da qualificação = hoje + 12 meses (PRO 5.10); suspensão
//     por documento ou requalificação vencida é levantada (avisa para liberar no Protheus);
//   - "com restrição" na requalificação exige plano de ação + prazo (PRO 5.10.2);
//   - NÃO REQUALIFICADO suspende até a regularização (observado o 5.6.2 para reativar);
//   - classe C/D sem plano de ação registrado: a suspensão vira bloqueio por plano (não libera);
//   - reaprovação de fornecedor reprovado (processo REATIVACAO): a média do IQF recomeça hoje
//     (iqf_desde) — senão o histórico que o reprovou o reprovaria de novo no 1º recebimento.
//
// body: { resultado, senha, declaracao?, observacao?, plano_acao?, prazo_regularizacao? }

const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');
const P = require('../../services/qfProcesso');
const Auditoria = require('../../services/auditoria');

const DECLARACAO_PADRAO = 'Declaro que revisei as evidências da qualificação deste fornecedor conforme o PRO 7.3.7 e registro minha decisão como Gerente de Engenharia.';
const INICIAIS = ['APROVADO', 'APROVADO_COM_RESTRICAO', 'REPROVADO'];
const REQUAL = ['REQUALIFICADO', 'REQUALIFICADO_COM_RESTRICAO', 'NAO_REQUALIFICADO'];
const data = (v) => { const s = Q.trim(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };

module.exports = (app) => ({
  verb: 'post',
  route: '/processos/:pid/aprovar',
  middlewares: [Q.mw(app, 'gerente')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const pid = Number(req.params.pid);
    const b = req.body || {};
    const resultado = Q.trim(b.resultado);
    const u = Q.usuario(req);
    try {
      if (![...INICIAIS, ...REQUAL].includes(resultado)) return res.status(400).json({ message: 'Resultado inválido.' });
      if (!(await Q.verificarSenha(Pg, u.id, b.senha))) {
        await Q.log(Pg, req, { entidade: 'qualificacao', entidadeId: pid, acao: 'ASSINATURA_RECUSADA', motivo: 'senha não confere' });
        return res.status(401).json({ message: 'Senha não confere — a assinatura não foi registrada.' });
      }
      const [proc] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_qualificacao WHERE id = @id`, { id: pid });
      if (!proc) return res.status(404).json({ message: 'Processo não encontrado.' });
      const requal = proc.tipo === 'REQUALIFICACAO';
      if (requal !== REQUAL.includes(resultado)) return res.status(400).json({ message: requal ? 'Requalificação usa os resultados do FORM 7.3.28.' : 'Qualificação usa os resultados do FORM 7.3.21.' });
      const ctx = await P.carregar(Pg, proc.fornecedor_id, pid);
      const prog = P.progresso(ctx);
      if (!prog.resultadosPermitidos.includes(resultado)) {
        return res.status(409).json({ message: `Não é possível registrar ${resultado.replace(/_/g, ' ')} agora.`, bloqueios: prog.bloqueios, falhas: prog.falhas, resultadosPermitidos: prog.resultadosPermitidos, sugestao: prog.sugestao });
      }
      const negativo = ['REPROVADO', 'NAO_REQUALIFICADO'].includes(resultado);
      if (negativo && !Q.nul(b.observacao)) return res.status(400).json({ message: 'Descreva o motivo.' });
      const plano = Q.nul(b.plano_acao) || proc.plano_acao;
      const prazo = data(b.prazo_regularizacao) || (proc.prazo_regularizacao ? String(proc.prazo_regularizacao).slice(0, 10) : null);
      if (resultado === 'REQUALIFICADO_COM_RESTRICAO' && (!plano || !prazo)) return res.status(400).json({ message: 'Requalificado com restrição exige plano de ação para as pendências e prazo de regularização (PRO 5.10.2).' });

      const f = ctx.fornecedor;
      const ficha = ctx.fichas.find(x => x.qualificacao_id === pid && x.formulario === '7.3.21') || null;
      const f7328 = ctx.fichas.find(x => x.qualificacao_id === pid && x.formulario === '7.3.28') || null;
      const declaracao = Q.nul(b.declaracao) || DECLARACAO_PADRAO;
      const estado = {
        processo: { id: proc.id, tipo: proc.tipo, fornecedor: f.codigo, criticidades: R.normCriticidades(f.criticidades) },
        formulario: requal ? '7.3.28' : '7.3.21',
        ficha: ficha ? { id: ficha.id, resultado: ficha.resultado, percentual: ficha.pontuacao_percentual } : null,
        ficha7328: f7328 ? { id: f7328.id, status: f7328.status } : null,
        analise: proc.analise || {}, sugestao: prog.sugestao || null,
        avaliacoes: ctx.avaliacoes.filter(a => a.qualificacao_id === pid).map(a => ({ id: a.id, tipo: a.tipo, resultado: a.resultado })),
        auditorias: ctx.auditorias.filter(a => a.qualificacao_id === pid).map(a => ({ id: a.id, resultado: a.resultado })),
        documentos: ctx.checklist.itens.map(i => ({ tipo: i.codigo, situacao: i.situacao, doc: i.documento ? i.documento.id : null })),
        resultado, plano, prazo, declaracao, assinante: { id: u.id, nome: u.nome }, em: new Date().toISOString()
      };
      const hash = Q.sha256(estado);
      const monit = R.monitorado(f);
      // status do fornecedor
      const statusForn = {
        APROVADO: 'APROVADO', APROVADO_COM_RESTRICAO: 'APROVADO_COM_RESTRICAO', REPROVADO: 'REPROVADO',
        REQUALIFICADO: 'APROVADO', REQUALIFICADO_COM_RESTRICAO: 'APROVADO_COM_RESTRICAO', NAO_REQUALIFICADO: 'SUSPENSO'
      }[resultado];
      const suspensoLiberavel = !negativo && f.status_qualificacao === 'SUSPENSO' && ['REQUALIFICACAO', 'DOCUMENTO'].includes(f.suspensao_tipo);
      const planoPendente = monit && ['C', 'D'].includes(f.classificacao) && !f.plano_acao_iqf ? (f.classificacao === 'D' ? 'PLANO_ACAO_D' : 'PLANO_ACAO_C') : null;
      const liberaSuspensao = suspensoLiberavel && !planoPendente;
      const reinicia = !negativo && proc.tipo === 'REATIVACAO';

      await Q.tx(Pg, async (q) => {
        await q(`UPDATE tab_qf_qualificacao SET status = @st, etapa = 'CONCLUIDO', concluido_em = NOW(),
                   aprovacao_resultado = @res, aprovacao_por = @u, aprovacao_nome = @nome, aprovacao_em = NOW(), aprovacao_ip = @ip,
                   aprovacao_declaracao = @decl, aprovacao_hash = @hash, plano_acao = @plano, prazo_regularizacao = @prazo,
                   motivo = COALESCE(@obs, motivo), atualizado_por = @u, atualizado_em = NOW()
                 WHERE id = @id`,
          { st: negativo ? 'REPROVADO' : 'APROVADO', res: resultado, u: u.id, nome: u.nome, ip: Q.ipDe(req), decl: declaracao, hash,
            plano, prazo, obs: Q.nul(b.observacao), id: pid });
        if (negativo && requal) {
          await q(`UPDATE tab_qf_fornecedor SET status_qualificacao = 'SUSPENSO', suspensao_tipo = 'REQUALIFICACAO', suspenso_em = NOW(),
                     motivo_suspensao = @m, atualizado_por = @u, atualizado_em = NOW() WHERE id = @f`,
            { m: `Não requalificado (FORM 7.3.28): ${Q.nul(b.observacao)}`, u: u.id, f: f.id });
        } else {
          await q(`UPDATE tab_qf_fornecedor SET status_qualificacao = @st,
                     data_aprovacao = CASE WHEN @aprovou::boolean THEN NOW() ELSE data_aprovacao END,
                     aprovado_por = CASE WHEN @aprovou::boolean THEN @u::int ELSE aprovado_por END,
                     qualificacao_valida_ate = CASE WHEN @aprovou::boolean AND @monit::boolean THEN (CURRENT_DATE + INTERVAL '12 months')::date ELSE qualificacao_valida_ate END,
                     sgq_questionario = CASE WHEN @nota::numeric IS NOT NULL THEN 'SIM' ELSE sgq_questionario END,
                     nota_sgq = COALESCE(@nota::numeric, nota_sgq),
                     suspensao_tipo = CASE WHEN @libera::boolean OR NOT @aprovou::boolean THEN NULL ELSE suspensao_tipo END,
                     motivo_suspensao = CASE WHEN @libera::boolean OR NOT @aprovou::boolean THEN NULL ELSE motivo_suspensao END,
                     suspenso_em = CASE WHEN @libera::boolean OR NOT @aprovou::boolean THEN NULL ELSE suspenso_em END,
                     ativo = CASE WHEN @aprovou::boolean THEN TRUE ELSE ativo END,
                     iqf_desde = CASE WHEN @reinicia::boolean THEN CURRENT_DATE ELSE iqf_desde END,
                     inspecao_100 = CASE WHEN @reinicia::boolean THEN FALSE ELSE inspecao_100 END,
                     legado = FALSE, atualizado_por = @u::int, atualizado_em = NOW()
                   WHERE id = @f`,
            { st: f.status_qualificacao === 'SUSPENSO' && !liberaSuspensao && !negativo ? 'SUSPENSO' : statusForn, aprovou: !negativo, monit,
              u: u.id, nota: ficha && ficha.status === 'ANALISADA' ? ficha.pontuacao_percentual : null, libera: liberaSuspensao, reinicia, f: f.id });
          if (suspensoLiberavel && planoPendente) {
            await q(`UPDATE tab_qf_fornecedor SET suspensao_tipo = @t, motivo_suspensao = @m WHERE id = @f`,
              { t: planoPendente, m: `Classe ${f.classificacao} sem plano de ação registrado: o recebimento continua bloqueado até a Engenharia registrar o plano.`, f: f.id });
          }
        }
        if (ficha) await q(`UPDATE tab_qf_ficha SET gerente_por = @u, gerente_nome = @nome, gerente_em = NOW(), atualizado_em = NOW() WHERE id = @id`, { u: u.id, nome: u.nome, id: ficha.id });
        if (f7328) await q(`UPDATE tab_qf_ficha SET status = 'ANALISADA', analisada_em = NOW(), analisada_por = @u, resultado = @res, token = NULL,
                              gerente_por = @u, gerente_nome = @nome, gerente_em = NOW(), atualizado_em = NOW() WHERE id = @id`,
          { u: u.id, nome: u.nome, res: resultado, id: f7328.id });
        await Q.log(Pg, req, {
          entidade: 'qualificacao', entidadeId: pid, fornecedorId: f.id, acao: 'ASSINATURA_APROVACAO',
          mudancas: [{ campo: 'formulario', para: requal ? 'FORM 7.3.28' : 'FORM 7.3.21' }, { campo: 'resultado', para: resultado },
            { campo: 'status_qualificacao', de: f.status_qualificacao, para: negativo && requal ? 'SUSPENSO' : statusForn },
            ...(!negativo && monit ? [{ campo: 'qualificacao_valida_ate', de: f.qualificacao_valida_ate, para: 'hoje + 12 meses' }] : []),
            { campo: 'hash', para: hash }],
          motivo: Q.nul(b.observacao) || declaracao
        }, q);
      });

      if (reinicia) await Q.recalcularFornecedor(app, f.id, { req, semAcoes: true });

      Auditoria.registrar(app, {
        modulo: 'Qualidade', submodulo: 'Qualificação de Fornecedores', acao: requal ? 'REQUALIFICACAO' : 'APROVACAO_FINAL', severidade: 'ALERTA', req,
        entidade: 'qualificacao', entidadeId: String(pid),
        descricao: `${u.nome} assinou ${resultado} para ${f.codigo} – ${f.razao_social} (hash ${hash.slice(0, 12)}…)`
      });
      const cfg = await Q.config(Pg);
      await Q.notificar(app, {
        chave: `aprovacao|${pid}`, tipo: requal ? 'REQUALIFICACAO' : 'APROVACAO', entidade: 'qualificacao', entidadeId: pid, fornecedorId: f.id,
        para: [...cfg.emails_engenharia, ...cfg.emails_qualidade],
        assunto: `[${requal ? 'Requalificação' : 'Qualificação'}] ${f.codigo} – ${f.razao_social}: ${resultado.replace(/_/g, ' ')}`,
        texto: [`O Gerente de Engenharia ${u.nome} registrou ${resultado.replace(/_/g, ' ')} (${requal ? 'FORM 7.3.28' : 'FORM 7.3.21'}) para ${f.codigo} – ${f.razao_social}.`,
          b.observacao ? `Observação: ${b.observacao}` : '',
          !negativo && monit ? 'Qualificação válida por 12 meses (requalificação anual — PRO 7.3.7 item 5.10).' : '',
          liberaSuspensao ? 'A suspensão foi levantada: REATIVAR o fornecedor no Protheus.' : '',
          suspensoLiberavel && planoPendente ? `Continua BLOQUEADO: classe ${f.classificacao} sem plano de ação registrado.` : '',
          reinicia ? 'Reaprovado após reprovação: a média do IQF recomeça a partir de hoje.' : '',
          negativo && requal ? 'Fornecedor SUSPENSO até a regularização: INATIVAR no Protheus.' : '',
          `Assinatura: ${hash}`].filter(Boolean).join('\n')
      });
      return res.json({ ok: true, resultado, hash });
    } catch (err) { return Q.falha(res, 'registrar a aprovação', err); }
  }
});

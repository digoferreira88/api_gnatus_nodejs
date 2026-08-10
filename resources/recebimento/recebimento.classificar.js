// POST /recebimento/:id/classificar
// Body: { itens: [{item, tes}], observacao? }
//
// Etapa final do fluxo: com a conferência CONFERIDA (física bateu com a NF),
// o fiscal informa a TES por item e a intranet chama o REST custom do Protheus
// (services/protheusClassificacao) que classifica a pré-nota (MATA103/ExecAuto
// preenchendo D1_TES e efetivando a entrada — F1_STATUS '' -> 'A').
//
// DIVERGENTE não classifica (regularizar e re-conferir antes). Perm 4005 ou
// 16001 (fiscal). ⚠️ Depende do endpoint do Diego (spec em docs/) — enquanto
// não publicado, devolve 502 com aviso claro.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([4005, 16001]);
const Auditoria = require('../../services/auditoria');
const Classificacao = require('../../services/protheusClassificacao');
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/:id/classificar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id inválido.' });
    const b = req.body || {};
    const itensTes = Array.isArray(b.itens) ? b.itens : [];
    const observacao = trim(b.observacao).slice(0, 500);
    // Dry-run: valida a pré-nota/TES no Protheus SEM efetivar a entrada.
    const simular = b.simular === true || b.simular === 'true' || b.simular === 1;

    try {
      const confRows = await Pg.connectAndQuery(
        `SELECT * FROM tab_receb_conferencia WHERE id = @id`, { id });
      if (!confRows.length) return res.status(404).json({ message: 'Conferência não encontrada.' });
      const conf = confRows[0];
      const status = trim(conf.status);

      if (status === 'CLASSIFICADA') return res.status(409).json({ message: 'Nota já classificada.' });
      if (status !== 'CONFERIDA') {
        return res.status(409).json({
          message: status === 'DIVERGENTE'
            ? 'Conferência DIVERGENTE — regularize e re-confira antes de classificar.'
            : `Conferência em "${status}" — finalize a conferência antes de classificar.`
        });
      }

      // TES por item: todos os itens da conferência precisam de TES (3 dígitos)
      const itensConf = await Pg.connectAndQuery(
        `SELECT item, produto FROM tab_receb_conferencia_item WHERE id_conf = @id ORDER BY item`, { id });
      const tesPorItem = new Map();
      itensTes.forEach(i => { const t = trim(i.tes); if (t) tesPorItem.set(trim(i.item), t); });
      const semTes = itensConf.filter(i => !tesPorItem.has(trim(i.item)));
      if (semTes.length) {
        return res.status(400).json({
          message: `Informe a TES de todos os itens (${semTes.length} sem TES).`,
          itensPendentes: semTes.map(i => trim(i.item))
        });
      }
      const tesInvalida = [...tesPorItem.values()].find(t => !/^\d{3}$/.test(t));
      if (tesInvalida) return res.status(400).json({ message: `TES inválida: "${tesInvalida}" (3 dígitos).` });

      // Chama o Protheus (REST custom Diego)
      let r;
      try {
        r = await Classificacao.classificar({
          filial: '01',
          doc: trim(conf.doc), serie: trim(conf.serie),
          fornecedor: trim(conf.fornece), loja: trim(conf.loja),
          operador: trim(user.EMAIL) || `id_${user.ID}`,
          observacao,
          itens: itensConf.map(i => ({ item: trim(i.item), tes: tesPorItem.get(trim(i.item)) })),
          simular
        });
      } catch (err) {
        const conexao = ehConexao(err);
        Auditoria.registrar(app, {
          modulo: 'Compras', submodulo: 'RecebimentoNF', acao: 'CLASSIFICAR_ERRO', severidade: 'CRITICO', req,
          entidade: 'receb_conferencia', entidadeId: String(id),
          descricao: `Erro de conexão ao classificar NF ${trim(conf.doc)}/${trim(conf.serie)}: ${err.message}`,
          meta: { id, erro: err.message, conexao }
        });
        return res.status(conexao ? 503 : 500).json({ ok: false, message: conexao ? MSG_INDISPONIVEL : ('Erro: ' + err.message) });
      }

      if (!r.ok) {
        const msg = r.body?.codigo_erro || r.body?.mensagem || r.body?.message
          || (r.httpStatus === 404
            ? 'Endpoint de classificação ainda não publicado no Protheus (aguardando rotina custom — ver docs/spec-protheus-classificacao-prenota.md).'
            : `Protheus retornou HTTP ${r.httpStatus}.`);
        Auditoria.registrar(app, {
          modulo: 'Compras', submodulo: 'RecebimentoNF', acao: 'CLASSIFICAR_FALHA', severidade: 'ALERTA', req,
          entidade: 'receb_conferencia', entidadeId: String(id),
          descricao: `Falha ao classificar NF ${trim(conf.doc)}/${trim(conf.serie)} (HTTP ${r.httpStatus})`,
          meta: { id, http: r.httpStatus, body: r.body }
        });
        return res.status(502).json({ ok: false, message: msg, status: r.httpStatus, body: r.body });
      }

      // Simulação (dry-run): validou no Protheus SEM efetivar. NÃO persiste
      // (não marca CLASSIFICADA, não grava TES) — só devolve o retorno.
      if (simular) {
        Auditoria.registrar(app, {
          modulo: 'Compras', submodulo: 'RecebimentoNF', acao: 'CLASSIFICAR_SIMULACAO', severidade: 'INFO', req,
          entidade: 'receb_conferencia', entidadeId: String(id),
          descricao: `Dry-run (simular) da classificação da NF ${trim(conf.doc)}/${trim(conf.serie)} — ${itensConf.length} item(ns), sem efetivar`,
          meta: { id, simular: true, itens: [...tesPorItem.entries()].map(([i, t]) => ({ item: i, tes: t })), protheus: r.body }
        });
        return res.json({ ok: true, id, simulado: true, status: trim(conf.status), protheus: r.body });
      }

      // Sucesso: grava TES nos itens + fecha o cabeçalho
      for (const [item, tes] of tesPorItem.entries()) {
        await Pg.connectAndQuery(
          `UPDATE tab_receb_conferencia_item SET tes=@tes WHERE id_conf=@id AND item=@item`,
          { tes, id, item });
      }
      await Pg.connectAndQuery(`
        UPDATE tab_receb_conferencia
           SET status='CLASSIFICADA', classificado_por=@uid, classificado_em=NOW(),
               protheus_resposta=@resp::jsonb, atualizado_em=NOW()
         WHERE id=@id`,
        { uid: user.ID, resp: JSON.stringify(r.body || {}), id });

      Auditoria.registrar(app, {
        modulo: 'Compras', submodulo: 'RecebimentoNF', acao: 'CLASSIFICAR', severidade: 'CRITICO', req,
        entidade: 'receb_conferencia', entidadeId: String(id),
        descricao: `Classificou NF ${trim(conf.doc)}/${trim(conf.serie)} (${trim(conf.fornecedor_nome)}) no Protheus — ${itensConf.length} item(ns)`,
        meta: { id, doc: trim(conf.doc), serie: trim(conf.serie), itens: [...tesPorItem.entries()].map(([i, t]) => ({ item: i, tes: t })) }
      });

      return res.json({ ok: true, id, status: 'CLASSIFICADA', protheus: r.body });
    } catch (err) {
      console.error('recebimento/classificar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

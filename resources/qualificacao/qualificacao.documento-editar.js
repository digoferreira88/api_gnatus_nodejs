// PUT /qualificacao/documentos/:docId — corrige número/datas/prazo/observação, ou:
//   acao=APROVAR  — a Engenharia conferiu o documento (PRO 4.1: "analisar os documentos");
//   acao=EXCLUIR  — exclusão lógica, com motivo.
// Perm 23003+ (Engenharia). Correção sempre com motivo; tudo vai para a trilha.

const Q = require('../../services/qfCore');

const data = (v) => { const s = Q.trim(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const dia = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);

module.exports = (app) => ({
  verb: 'put',
  route: '/documentos/:docId',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.docId);
    const b = req.body || {};
    try {
      const [atual] = await Pg.connectAndQuery(
        `SELECT d.*, t.exige_validade, t.nome tipo_nome FROM tab_qf_documento d JOIN tab_qf_tipo_documento t ON t.id = d.tipo_documento_id WHERE d.id = @id`, { id });
      if (!atual) return res.status(404).json({ message: 'Documento não encontrado.' });
      if (['SUBSTITUIDO', 'EXCLUIDO'].includes(atual.status)) return res.status(409).json({ message: 'Documento substituído/excluído não pode ser alterado.' });
      const u = Q.usuario(req);
      const acao = Q.trim(b.acao).toUpperCase();

      if (acao === 'APROVAR' || acao === 'EXCLUIR') {
        if (acao === 'EXCLUIR' && !Q.nul(b.motivo)) return res.status(400).json({ message: 'Informe o motivo da exclusão.' });
        if (acao === 'APROVAR' && atual.aprovado_em) return res.status(409).json({ message: 'Documento já conferido.' });
        const [doc] = await Pg.connectAndQuery(
          acao === 'APROVAR'
            ? `UPDATE tab_qf_documento SET aprovado_por = @u, aprovado_em = NOW(), atualizado_por = @u, atualizado_em = NOW() WHERE id = @id RETURNING *`
            : `UPDATE tab_qf_documento SET status = 'EXCLUIDO', justificativa = @m, atualizado_por = @u, atualizado_em = NOW() WHERE id = @id RETURNING *`,
          { u: u.id, id, m: Q.nul(b.motivo) });
        await Q.log(Pg, req, { entidade: 'documento', entidadeId: id, fornecedorId: atual.fornecedor_id, acao,
          mudancas: acao === 'APROVAR' ? [{ campo: 'conferido_por', para: u.nome }] : [{ campo: 'status', de: atual.status, para: 'EXCLUIDO' }], motivo: b.motivo });
        return res.json({ ok: true, documento: doc });
      }

      const novo = { ...atual, data_emissao: dia(atual.data_emissao), data_validade: dia(atual.data_validade), prazo_regularizacao: dia(atual.prazo_regularizacao) };
      if ('numero' in b) novo.numero = Q.nul(b.numero);
      if ('data_emissao' in b) novo.data_emissao = data(b.data_emissao);
      if ('data_validade' in b) novo.data_validade = data(b.data_validade);
      if ('prazo_regularizacao' in b) novo.prazo_regularizacao = data(b.prazo_regularizacao);
      if ('observacoes' in b) novo.observacoes = Q.nul(b.observacoes);
      if ('status' in b && ['VIGENTE', 'PROTOCOLADO'].includes(b.status) && atual.status !== 'DISPENSADO') novo.status = b.status;
      if (novo.status === 'PROTOCOLADO' && !novo.prazo_regularizacao) return res.status(400).json({ message: 'Protocolo precisa do prazo de regularização (PRO 7.3.7 item 5.4).' });
      if (novo.status === 'VIGENTE') novo.prazo_regularizacao = null;
      if (novo.status === 'VIGENTE' && atual.exige_validade && !novo.data_validade) return res.status(400).json({ message: `${atual.tipo_nome}: informe a data de validade.` });
      const campos = ['numero', 'data_emissao', 'data_validade', 'prazo_regularizacao', 'observacoes', 'status'];
      const mud = Q.diff({ ...atual, data_emissao: dia(atual.data_emissao), data_validade: dia(atual.data_validade), prazo_regularizacao: dia(atual.prazo_regularizacao) }, novo, campos);
      if (!mud.length) return res.json({ ok: true, documento: atual });
      if (!Q.nul(b.motivo)) return res.status(400).json({ message: 'Informe o motivo da correção.' });
      const [doc] = await Pg.connectAndQuery(
        `UPDATE tab_qf_documento SET ${campos.map(c => `${c} = @${c}`).join(', ')},
                aviso_30_em = CASE WHEN @data_validade::date IS DISTINCT FROM data_validade OR @prazo_regularizacao::date IS DISTINCT FROM prazo_regularizacao THEN NULL ELSE aviso_30_em END,
                aviso_1_em = CASE WHEN @data_validade::date IS DISTINCT FROM data_validade OR @prazo_regularizacao::date IS DISTINCT FROM prazo_regularizacao THEN NULL ELSE aviso_1_em END,
                aviso_vencido_em = CASE WHEN @data_validade::date IS DISTINCT FROM data_validade OR @prazo_regularizacao::date IS DISTINCT FROM prazo_regularizacao THEN NULL ELSE aviso_vencido_em END,
                atualizado_por = @u, atualizado_em = NOW()
          WHERE id = @id RETURNING *`, { ...Object.fromEntries(campos.map(c => [c, novo[c]])), u: u.id, id });
      await Q.log(Pg, req, { entidade: 'documento', entidadeId: id, fornecedorId: atual.fornecedor_id, acao: 'ALTERAR', mudancas: mud, motivo: b.motivo });
      return res.json({ ok: true, documento: doc });
    } catch (err) { return Q.falha(res, 'alterar o documento', err); }
  }
});

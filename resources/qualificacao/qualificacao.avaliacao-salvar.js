// POST /qualificacao/fornecedores/:id/avaliacoes — avaliação DIMENSIONAL (FORM 7.3.22)
// ou FUNCIONAL (FORM 7.3.23) da amostra, com os itens medidos/ensaiados (passo 8).
// Com `id` no corpo, altera (os itens são substituídos). Perm 23003+ (Engenharia).
//
// Resultado (PRO 7.3.7 itens 5.7.1 e 5.7.2):
//   APROVADO — todos os itens conformes;
//   APROVADO_COM_RESTRICAO — não conformidade em item NÃO crítico, aceita mediante ACORDO
//     FORMAL com o fornecedor (acordo_formal obrigatório);
//   REPROVADO — obrigatório quando algum item CRÍTICO está não conforme;
//   NAO_APLICAVEL — a avaliação não se aplica ao fornecimento (justificativa em observações).

const Q = require('../../services/qfCore');

const data = (v) => { const s = Q.trim(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const CAMPOS = ['qualificacao_id', 'amostra_id', 'tipo', 'componente_codigo', 'componente_descricao', 'data_recebimento_amostra', 'data_avaliacao', 'avaliado_por', 'avaliado_nome', 'resultado', 'acordo_formal', 'observacoes'];
const corta = (v, n) => (Q.nul(v) ? Q.trim(v).slice(0, n) : null);

module.exports = (app) => ({
  verb: 'post',
  route: '/fornecedores/:id/avaliacoes',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const fid = Number(req.params.id);
    const b = req.body || {};
    const u = Q.usuario(req);
    try {
      const [proc] = await Pg.connectAndQuery(`SELECT id FROM tab_qf_qualificacao WHERE fornecedor_id = @id AND status IN ('EM_ANDAMENTO','PAUSADO') ORDER BY id DESC LIMIT 1`, { id: fid });
      const itens = (Array.isArray(b.itens) ? b.itens : []).map((i, k) => ({
        ordem: k + 1, caracteristica: corta(i.caracteristica, 200), nominal: corta(i.nominal, 40), tolerancia: corta(i.tolerancia, 40),
        medido: corta(i.medido, 80), unidade: corta(i.unidade, 20), instrumento: corta(i.instrumento, 80),
        critico: i.critico === true, status: i.status === 'NAO_CONFORME' ? 'NAO_CONFORME' : 'CONFORME'
      })).filter(i => i.caracteristica);
      const d = {
        qualificacao_id: b.qualificacao_id ? Number(b.qualificacao_id) : (proc ? proc.id : null),
        amostra_id: b.amostra_id ? Number(b.amostra_id) : null,
        tipo: ['DIMENSIONAL', 'FUNCIONAL'].includes(b.tipo) ? b.tipo : null,
        componente_codigo: corta(b.componente_codigo, 30), componente_descricao: corta(b.componente_descricao, 200),
        data_recebimento_amostra: data(b.data_recebimento_amostra), data_avaliacao: data(b.data_avaliacao),
        avaliado_por: u.id, avaliado_nome: u.nome,
        resultado: ['APROVADO', 'APROVADO_COM_RESTRICAO', 'REPROVADO', 'NAO_APLICAVEL'].includes(b.resultado) ? b.resultado : null,
        acordo_formal: Q.nul(b.acordo_formal), observacoes: Q.nul(b.observacoes)
      };
      if (!d.tipo) return res.status(400).json({ message: 'Informe o tipo: dimensional ou funcional.' });
      if (d.resultado && !d.data_avaliacao) return res.status(400).json({ message: 'Informe a data da avaliação.' });
      if (d.resultado === 'NAO_APLICAVEL') {
        if (!d.observacoes) return res.status(400).json({ message: 'Justifique por que a avaliação não se aplica (observações).' });
      } else if (d.resultado && !itens.length) return res.status(400).json({ message: `Registre ao menos um item ${d.tipo === 'DIMENSIONAL' ? 'medido (cota)' : 'ensaiado'}.` });
      const ncCritico = itens.filter(i => i.critico && i.status === 'NAO_CONFORME');
      if (d.resultado && d.resultado !== 'REPROVADO' && ncCritico.length) {
        return res.status(400).json({ message: `Requisito crítico não atendido (${ncCritico.map(i => i.caracteristica).join(', ')}): o resultado é REPROVADO (PRO 7.3.7 item 5.7).` });
      }
      if (d.resultado === 'APROVADO' && itens.some(i => i.status === 'NAO_CONFORME')) {
        return res.status(400).json({ message: 'Há item não conforme: o resultado deve ser APROVADO COM RESTRIÇÃO (com acordo formal) ou REPROVADO.' });
      }
      if (d.resultado === 'APROVADO_COM_RESTRICAO' && !d.acordo_formal) {
        return res.status(400).json({ message: 'Aprovado com restrição exige o acordo formal com o fornecedor sobre a não conformidade aceita (PRO 7.3.7 item 5.7).' });
      }
      if (d.resultado !== 'APROVADO_COM_RESTRICAO') d.acordo_formal = null;
      let a;
      await Q.tx(Pg, async (q) => {
        if (b.id) {
          const [antes] = await q(`SELECT * FROM tab_qf_avaliacao WHERE id = @id AND fornecedor_id = @f`, { id: Number(b.id), f: fid });
          if (!antes) throw Object.assign(new Error('Avaliação não encontrada.'), { status: 404 });
          [a] = await q(`UPDATE tab_qf_avaliacao SET ${CAMPOS.map(c => `${c} = @${c}`).join(', ')}, atualizado_por = @u, atualizado_em = NOW() WHERE id = @id RETURNING *`,
            { ...d, u: u.id, id: antes.id });
          await q(`DELETE FROM tab_qf_avaliacao_item WHERE avaliacao_id = @id`, { id: a.id });
          await Q.log(Pg, req, { entidade: 'avaliacao', entidadeId: a.id, fornecedorId: fid, acao: 'ALTERAR',
            mudancas: [...Q.diff(antes, a, CAMPOS.filter(c => !c.startsWith('avaliado'))), { campo: 'itens', para: itens.length }], motivo: b.motivo }, q);
        } else {
          [a] = await q(`INSERT INTO tab_qf_avaliacao (fornecedor_id, ${CAMPOS.join(', ')}, criado_por, atualizado_por)
                         VALUES (@f, ${CAMPOS.map(c => '@' + c).join(', ')}, @u, @u) RETURNING *`, { ...d, f: fid, u: u.id });
          await Q.log(Pg, req, { entidade: 'avaliacao', entidadeId: a.id, fornecedorId: fid, acao: 'CRIAR',
            mudancas: [{ campo: 'tipo', para: d.tipo }, { campo: 'resultado', para: d.resultado }, { campo: 'itens', para: itens.length }] }, q);
        }
        if (itens.length) {
          await q(`INSERT INTO tab_qf_avaliacao_item (avaliacao_id, ordem, caracteristica, critico, nominal, tolerancia, medido, unidade, instrumento, status)
                   SELECT @a, ordem, caracteristica, critico, nominal, tolerancia, medido, unidade, instrumento, status
                     FROM jsonb_to_recordset(@rows::jsonb) AS x(ordem int, caracteristica text, critico boolean, nominal text, tolerancia text, medido text, unidade text, instrumento text, status text)`,
            { a: a.id, rows: JSON.stringify(itens) });
        }
        if (d.resultado && d.amostra_id) {
          await q(`UPDATE tab_qf_amostra SET status = 'AVALIADA', atualizado_por = @u, atualizado_em = NOW() WHERE id = @id AND status IN ('SOLICITADA','RECEBIDA')`, { id: d.amostra_id, u: u.id });
        }
      });
      return res.json({ ok: true, avaliacao: a, itens: itens.length });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ message: err.message });
      return Q.falha(res, 'salvar a avaliação', err);
    }
  }
});

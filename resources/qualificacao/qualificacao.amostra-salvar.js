// POST /qualificacao/fornecedores/:id/amostras — solicitação/recebimento de amostra
// (passo 7). Com `id` no corpo, altera. Laudo do fornecedor vai em /anexos
// (entidade "amostra", categoria LAUDO). Perm 23003+ (Engenharia).

const Q = require('../../services/qfCore');

const data = (v) => { const s = Q.trim(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const CAMPOS = ['qualificacao_id', 'componente_codigo', 'componente_descricao', 'quantidade', 'status', 'data_solicitacao', 'data_recebimento', 'observacoes'];

module.exports = (app) => ({
  verb: 'post',
  route: '/fornecedores/:id/amostras',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const fid = Number(req.params.id);
    const b = req.body || {};
    try {
      const [proc] = await Pg.connectAndQuery(`SELECT id FROM tab_qf_qualificacao WHERE fornecedor_id = @id AND status IN ('EM_ANDAMENTO','PAUSADO') ORDER BY id DESC LIMIT 1`, { id: fid });
      const d = {
        qualificacao_id: b.qualificacao_id ? Number(b.qualificacao_id) : (proc ? proc.id : null),
        componente_codigo: Q.nul(b.componente_codigo) ? Q.trim(b.componente_codigo).slice(0, 30) : null,
        componente_descricao: Q.nul(b.componente_descricao) ? Q.trim(b.componente_descricao).slice(0, 200) : null,
        quantidade: b.quantidade === '' || b.quantidade == null ? null : Number(b.quantidade),
        status: ['SOLICITADA', 'RECEBIDA', 'AVALIADA', 'CANCELADA'].includes(b.status) ? b.status : 'SOLICITADA',
        data_solicitacao: data(b.data_solicitacao) || new Date().toISOString().slice(0, 10),
        data_recebimento: data(b.data_recebimento), observacoes: Q.nul(b.observacoes)
      };
      if (!d.componente_codigo && !d.componente_descricao) return res.status(400).json({ message: 'Informe o componente da amostra.' });
      if (['RECEBIDA', 'AVALIADA'].includes(d.status) && !d.data_recebimento) return res.status(400).json({ message: 'Informe a data de recebimento da amostra.' });
      const u = Q.usuario(req);
      let a;
      if (b.id) {
        const [antes] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_amostra WHERE id = @id AND fornecedor_id = @f`, { id: Number(b.id), f: fid });
        if (!antes) return res.status(404).json({ message: 'Amostra não encontrada.' });
        [a] = await Pg.connectAndQuery(
          `UPDATE tab_qf_amostra SET ${CAMPOS.map(c => `${c} = @${c}`).join(', ')}, atualizado_por = @u, atualizado_em = NOW() WHERE id = @id RETURNING *`,
          { ...d, u: u.id, id: antes.id });
        await Q.log(Pg, req, { entidade: 'amostra', entidadeId: a.id, fornecedorId: fid, acao: 'ALTERAR', mudancas: Q.diff(antes, a, CAMPOS), motivo: b.motivo });
      } else {
        [a] = await Pg.connectAndQuery(
          `INSERT INTO tab_qf_amostra (fornecedor_id, ${CAMPOS.join(', ')}, criado_por, atualizado_por)
           VALUES (@f, ${CAMPOS.map(c => '@' + c).join(', ')}, @u, @u) RETURNING *`, { ...d, f: fid, u: u.id });
        await Q.log(Pg, req, { entidade: 'amostra', entidadeId: a.id, fornecedorId: fid, acao: 'CRIAR', mudancas: [{ campo: 'componente', para: d.componente_codigo || d.componente_descricao }] });
      }
      return res.json({ ok: true, amostra: a });
    } catch (err) { return Q.falha(res, 'salvar a amostra', err); }
  }
});

// POST /qualificacao/tipos-documento — cria/altera um tipo de documento regulatório e
// a regra de exigência por criticidade (A, B, C, D: OBRIGATORIO, CONDICIONAL ou não se aplica —
// matriz da seção "Documentação do fornecedor" do FORM 7.3.21).
// Perm 23006 (Administração).

const Q = require('../../services/qfCore');

const REGRA = (v) => (['OBRIGATORIO', 'CONDICIONAL'].includes(v) ? v : null);
const CAMPOS = ['codigo', 'nome', 'regra_a', 'regra_b', 'regra_c', 'regra_d', 'somente_nacional', 'condicao', 'exige_validade', 'gerado_sistema', 'ordem', 'ativo'];

module.exports = (app) => ({
  verb: 'post',
  route: '/tipos-documento',
  middlewares: [Q.mw(app, 'admin')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    try {
      const d = {
        codigo: Q.trim(b.codigo).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40), nome: Q.trim(b.nome).slice(0, 220),
        regra_a: REGRA(b.regra_a), regra_b: REGRA(b.regra_b), regra_c: REGRA(b.regra_c), regra_d: REGRA(b.regra_d), somente_nacional: !!b.somente_nacional,
        condicao: Q.nul(b.condicao) ? Q.trim(b.condicao).slice(0, 220) : null, exige_validade: !!b.exige_validade,
        gerado_sistema: !!b.gerado_sistema, ordem: Number(b.ordem) || 0, ativo: b.ativo !== false
      };
      if (!d.codigo || !d.nome) return res.status(400).json({ message: 'Código e nome são obrigatórios.' });
      const u = Q.usuario(req);
      let t;
      if (b.id) {
        const [antes] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_tipo_documento WHERE id = @id`, { id: Number(b.id) });
        if (!antes) return res.status(404).json({ message: 'Tipo não encontrado.' });
        [t] = await Pg.connectAndQuery(
          `UPDATE tab_qf_tipo_documento SET ${CAMPOS.map(c => `${c} = @${c}`).join(', ')}, atualizado_por = @u, atualizado_em = NOW() WHERE id = @id RETURNING *`,
          { ...d, u: u.id, id: antes.id });
        await Q.log(Pg, req, { entidade: 'tipo_documento', entidadeId: t.id, acao: 'ALTERAR', mudancas: Q.diff(antes, t, CAMPOS), motivo: b.motivo });
      } else {
        [t] = await Pg.connectAndQuery(
          `INSERT INTO tab_qf_tipo_documento (${CAMPOS.join(', ')}, atualizado_por) VALUES (${CAMPOS.map(c => '@' + c).join(', ')}, @u) RETURNING *`, { ...d, u: u.id });
        await Q.log(Pg, req, { entidade: 'tipo_documento', entidadeId: t.id, acao: 'CRIAR', mudancas: [{ campo: 'codigo', para: d.codigo }] });
      }
      return res.json({ ok: true, tipo: t });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ message: 'Já existe um tipo com esse código.' });
      return Q.falha(res, 'salvar o tipo de documento', err);
    }
  }
});

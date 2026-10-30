// POST /qualificacao/fornecedores/:id/sincronizar — atualiza o retrato do cadastro
// (razão, fantasia, CNPJ, UF, endereço, contato, bloqueio) a partir da SA2.
// Contato preenchido no módulo não é apagado por um vazio do ERP. Perm 23003+.

const Q = require('../../services/qfCore');
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

const CAMPOS = ['razao_social', 'nome_fantasia', 'cnpj', 'pais', 'nacional', 'estado', 'cidade', 'endereco', 'cep', 'contato_nome', 'contato_email', 'contato_telefone', 'bloqueado_protheus', 'loja'];

module.exports = (app) => ({
  verb: 'post',
  route: '/fornecedores/:id/sincronizar',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const id = Number(req.params.id);
    try {
      const [f] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id });
      if (!f) return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      if (!/^\d{6}$/.test(f.codigo)) return res.status(400).json({ message: 'Fornecedor com código provisório — informe o código do Protheus antes de sincronizar.' });
      let sa2;
      try { sa2 = await Q.lerSA2(Protheus, f.codigo); }
      catch (e) { if (ehConexao(e)) return res.status(503).json({ message: MSG_INDISPONIVEL, conexao: true }); throw e; }
      if (!sa2) return res.status(404).json({ message: `Código ${f.codigo} não encontrado na SA2.` });
      const novo = { ...f };
      for (const k of CAMPOS) {
        if (k.startsWith('contato_') && !sa2[k]) continue;
        if (sa2[k] !== undefined) novo[k] = sa2[k];
      }
      const mud = Q.diff(f, novo, CAMPOS);
      if (!mud.length) return res.json({ ok: true, alterado: false, fornecedor: f });
      const [depois] = await Pg.connectAndQuery(
        `UPDATE tab_qf_fornecedor SET ${CAMPOS.map(c => `${c} = @${c}`).join(', ')}, atualizado_em = NOW() WHERE id = @id RETURNING *`,
        { ...Object.fromEntries(CAMPOS.map(c => [c, novo[c] ?? null])), id });
      await Q.log(Pg, req, { entidade: 'fornecedor', entidadeId: id, fornecedorId: id, acao: 'SINCRONIZAR_SA2', mudancas: mud });
      return res.json({ ok: true, alterado: true, mudancas: mud.map(m => m.campo), fornecedor: depois });
    } catch (err) { return Q.falha(res, 'sincronizar com o Protheus', err); }
  }
});

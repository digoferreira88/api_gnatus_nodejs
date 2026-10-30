// PUT /qualificacao/fornecedores/:id — altera cadastro, criticidades (A/B/C/D, pelos itens que
// fornece — PRO 5.2) e tipo (Engenharia)
// e a avaliação do SGQ / nota (Qualidade). Fornecedor já qualificado exige motivo.
// Código provisório (P00001) pode ser trocado pelo A2_COD quando o ERP cadastrar.

const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');

const CADASTRO = ['razao_social', 'nome_fantasia', 'cnpj', 'pais', 'endereco', 'cidade', 'estado', 'cep', 'contato_nome', 'contato_email', 'contato_telefone', 'observacoes'];
const SGQ = ['sgq_bpf', 'sgq_iso13485', 'sgq_iso9001', 'sgq_acordo', 'sgq_questionario'];

module.exports = (app) => ({
  verb: 'put',
  route: '/fornecedores/:id',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const id = Number(req.params.id);
    const b = req.body || {};
    try {
      const niveis = await Q.niveisDoUsuario(Pg, req);
      const [atual] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_fornecedor WHERE id = @id`, { id });
      if (!atual) return res.status(404).json({ message: 'Fornecedor não encontrado.' });
      const motivo = Q.nul(b.motivo);
      if (atual.status_qualificacao !== 'EM_QUALIFICACAO' && !motivo) {
        return res.status(400).json({ message: 'Fornecedor já qualificado: informe o motivo da alteração.' });
      }

      const novo = { ...atual };
      for (const k of CADASTRO) if (k in b) novo[k] = Q.nul(b[k]);
      if ('estado' in b) novo.estado = novo.estado ? novo.estado.slice(0, 2).toUpperCase() : null;
      if ('nacional' in b) novo.nacional = !!b.nacional;
      if ('tipo_fornecimento' in b) {
        if (b.tipo_fornecimento && !['MP', 'SERVICO', 'MP_SERVICO', 'PRODUTO'].includes(b.tipo_fornecimento)) return res.status(400).json({ message: 'Tipo de fornecimento inválido.' });
        novo.tipo_fornecimento = b.tipo_fornecimento || null;
      }
      if ('criticidades' in b) novo.criticidades = R.normCriticidades(b.criticidades);
      const mexeuSgq = SGQ.some(k => k in b) || 'nota_sgq' in b;
      if (mexeuSgq && !niveis.qualidade) return res.status(403).json({ message: 'A avaliação do SGQ é registrada pela Qualidade.' });
      for (const k of SGQ) if (k in b) {
        if (b[k] && !['SIM', 'NAO', 'NA'].includes(b[k])) return res.status(400).json({ message: `${k}: use SIM, NAO ou NA.` });
        novo[k] = b[k] || null;
      }
      if ('nota_sgq' in b) novo.nota_sgq = b.nota_sgq === '' || b.nota_sgq == null ? null : Number(b.nota_sgq);

      if ('codigo' in b && R.normalizarCodigo(b.codigo) !== atual.codigo) {
        if (!/^P\d{5}$/.test(atual.codigo)) return res.status(400).json({ message: 'Só o código PROVISÓRIO pode ser trocado pelo código do Protheus.' });
        const cod = R.normalizarCodigo(b.codigo);
        if (!/^\d{6}$/.test(cod)) return res.status(400).json({ message: 'Código do Protheus deve ter 6 dígitos.' });
        const [ja] = await Pg.connectAndQuery(`SELECT id FROM tab_qf_fornecedor WHERE codigo = @c`, { c: cod });
        if (ja) return res.status(409).json({ message: `O código ${cod} já pertence a outro fornecedor do módulo.` });
        novo.codigo = cod;
      }
      if (!Q.trim(novo.razao_social)) return res.status(400).json({ message: 'Razão social é obrigatória.' });

      const campos = ['codigo', ...CADASTRO, 'nacional', 'tipo_fornecimento', 'criticidades', ...SGQ, 'nota_sgq'];
      const mud = Q.diff({ ...atual, criticidades: (atual.criticidades || []).join(',') }, { ...novo, criticidades: (novo.criticidades || []).join(',') }, campos);
      const u = Q.usuario(req);
      // informar a criticidade com processo aberto conta como o passo 2 confirmado —
      // inclusive quando a criticidade confirmada é a que já estava
      if ('criticidades' in b) {
        await Pg.connectAndQuery(
          `UPDATE tab_qf_qualificacao SET criticidade_definida = TRUE, atualizado_por = @u, atualizado_em = NOW()
            WHERE fornecedor_id = @id AND status IN ('EM_ANDAMENTO','PAUSADO') AND NOT criticidade_definida`, { id, u: u.id });
      }
      if (!mud.length) return res.json({ ok: true, fornecedor: atual, alterado: false });

      const [f] = await Pg.connectAndQuery(
        `UPDATE tab_qf_fornecedor SET ${campos.map(c => c === 'criticidades' ? 'criticidades = @criticidades::varchar[]' : `${c} = @${c}`).join(', ')}, atualizado_por = @uid, atualizado_em = NOW()
          WHERE id = @id RETURNING *`, { ...Object.fromEntries(campos.map(c => [c, novo[c]])), uid: u.id, id });
      if (novo.codigo !== atual.codigo) {
        await Pg.connectAndQuery(`UPDATE tab_qf_inspecao SET fornecedor_codigo = @c WHERE fornecedor_id = @id`, { c: novo.codigo, id });
      }
      await Q.log(Pg, req, { entidade: 'fornecedor', entidadeId: id, fornecedorId: id, acao: 'ALTERAR', mudancas: mud, motivo });
      // virar crítico/não crítico muda o monitoramento (classe do IQF) — sem disparar ações
      let recalculo = null;
      if (mud.some(m => m.campo === 'criticidades')) recalculo = await Q.recalcularFornecedor(app, id, { req, semAcoes: true });
      return res.json({ ok: true, fornecedor: f, alterado: true, mudancas: mud.map(m => m.campo), recalculo });
    } catch (err) { return Q.falha(res, 'alterar o fornecedor', err); }
  }
});

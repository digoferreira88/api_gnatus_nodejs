// PUT /contratos/:id — atualiza contrato (apenas campos enviados)
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5003]);
const Auditoria = require('../../services/auditoria');

const trim = (v) => v === undefined ? undefined : (v == null ? null : String(v).trim() || null);
const toN  = (v) => v === undefined ? undefined : ((v == null || v === '') ? null : Number(v));
const toDate = (v) => v === undefined ? undefined : ((v && /^\d{4}-\d{2}-\d{2}/.test(v)) ? v.slice(0, 10) : null);

// (campoBody, campoBD, conversor)
const CAMPOS = [
  ['titulo', 'titulo', trim],
  ['descricao', 'descricao', trim],
  ['tipo', 'tipo', trim],
  ['contraparte_tipo', 'contraparte_tipo', trim],
  ['contraparte_cod', 'contraparte_cod', trim],
  ['contraparte_loja', 'contraparte_loja', trim],
  ['contraparte_nome', 'contraparte_nome', trim],
  ['contraparte_cnpj', 'contraparte_cnpj', trim],
  ['contraparte_email', 'contraparte_email', trim],
  ['contraparte_tel', 'contraparte_tel', trim],
  ['contraparte_endereco', 'contraparte_endereco', trim],
  ['id_user_responsavel', 'id_user_responsavel', toN],
  ['responsavel_nome', 'responsavel_nome', trim],
  ['responsavel_email', 'responsavel_email', trim],
  ['responsavel_departamento', 'responsavel_departamento', trim],
  ['vigencia_inicio', 'vigencia_inicio', toDate],
  ['vigencia_fim', 'vigencia_fim', toDate],
  ['valor_total', 'valor_total', toN],
  ['valor_mensal', 'valor_mensal', toN],
  ['moeda', 'moeda', trim],
  ['indice_reajuste', 'indice_reajuste', trim],
  ['mes_aniversario_reajuste', 'mes_aniversario_reajuste', toN],
  ['dia_vencimento_mensal', 'dia_vencimento_mensal', toN],
  ['renovacao_automatica', 'renovacao_automatica', (v) => v === undefined ? undefined : !!v],
  ['prazo_renovacao_meses', 'prazo_renovacao_meses', toN],
  ['encerrado', 'encerrado', (v) => v === undefined ? undefined : !!v],
  ['data_encerramento', 'data_encerramento', toDate],
  ['motivo_encerramento', 'motivo_encerramento', trim],
  ['observacoes', 'observacoes', trim]
];

module.exports = (app) => ({
  verb: 'put',
  route: '/:id',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });
    const b = req.body || {};

    try {
      const cur = await Pg.connectAndQuery(`SELECT * FROM tab_contrato WHERE id = @id`, { id });
      if (!cur.length) return res.status(404).json({ message: 'Contrato nao encontrado.' });
      const antes = cur[0];

      const sets = [];
      const params = { id };
      const diff = {};
      for (const [bk, dk, conv] of CAMPOS) {
        if (!Object.prototype.hasOwnProperty.call(b, bk)) continue;
        const novoVal = conv(b[bk]);
        if (String(antes[dk] ?? '') === String(novoVal ?? '')) continue;
        sets.push(`${dk} = @${dk}`);
        params[dk] = novoVal;
        diff[dk] = { antes: antes[dk], depois: novoVal };
      }
      // meta (jsonb) tem tratamento separado
      if (b.meta !== undefined) {
        sets.push('meta = @meta::jsonb');
        params.meta = b.meta ? JSON.stringify(b.meta) : null;
        diff.meta = { antes: antes.meta, depois: b.meta };
      }

      if (!sets.length) return res.json({ ok: true, alterado: false });

      sets.push('id_user_atualizou = @uid');
      sets.push('atualizado_em = NOW()');
      params.uid = user?.ID || null;

      await Pg.connectAndQuery(
        `UPDATE tab_contrato SET ${sets.join(', ')} WHERE id = @id`,
        params
      );

      Auditoria.registrar(app, {
        modulo: 'ApoioGerencial', submodulo: 'Contratos',
        acao: 'UPDATE', severidade: 'INFO',
        req, entidade: 'contrato', entidadeId: String(id),
        descricao: `Atualizou contrato ${antes.numero}: ${Object.keys(diff).join(', ')}`,
        antes: Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.antes])),
        depois: Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.depois]))
      });

      return res.json({ ok: true, alterado: true, campos_alterados: Object.keys(diff) });
    } catch (err) {
      console.error('contratos/update:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

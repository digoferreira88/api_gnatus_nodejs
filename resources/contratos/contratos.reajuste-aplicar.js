// POST /contratos/:id/reajuste-aplicar
// Cria um aditivo de REAJUSTE em RASCUNHO com os valores calculados (do preview).
// Body opcional: { meses, percentual_override, valor_mensal_novo, valor_total_novo, descricao }.
// Nao aprova automaticamente — o operador precisa aprovar (perm 5004) no endpoint
// /aditivos/:aid/aprovar pra aplicar no contrato.
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5003]);
const Bcb = require('../../services/bcbIndices');
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'post',
  route: '/:id/reajuste-aplicar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    const b = req.body || {};
    try {
      const r = await Pg.connectAndQuery(`SELECT * FROM tab_contrato WHERE id = @id`, { id });
      if (!r.length) return res.status(404).json({ message: 'Contrato nao encontrado.' });
      const c = r[0];
      if (!c.indice_reajuste || c.indice_reajuste === 'NENHUM') {
        return res.status(400).json({ message: 'Sem indice cadastrado.' });
      }

      let percentual = Number(b.percentual_override);
      let infoIndice = null;
      if (!Number.isFinite(percentual)) {
        const v = await Bcb.variacaoAcumulada(c.indice_reajuste, Number(b.meses || 12));
        percentual = v.percentual_acumulado;
        infoIndice = `${c.indice_reajuste} ${v.meses_usados}m (${v.periodo_inicio} a ${v.periodo_fim})`;
      } else {
        infoIndice = `${c.indice_reajuste} (override ${percentual}%)`;
      }

      const novoMensal = b.valor_mensal_novo != null
        ? Number(b.valor_mensal_novo)
        : (c.valor_mensal != null ? Bcb.aplicarReajuste(Number(c.valor_mensal), percentual) : null);
      const novoTotal = b.valor_total_novo != null
        ? Number(b.valor_total_novo)
        : (c.valor_total != null ? Bcb.aplicarReajuste(Number(c.valor_total), percentual) : null);

      // Proximo numero do aditivo
      const ult = await Pg.connectAndQuery(
        `SELECT COUNT(*) qt FROM tab_contrato_aditivo WHERE id_contrato = @id`, { id }
      );
      const numero = `${Number(ult[0]?.qt || 0) + 1}`;

      const descricao = (b.descricao && String(b.descricao).trim()) ||
        `Reajuste automatico — ${infoIndice} = +${percentual.toFixed(4)}%`;

      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_contrato_aditivo
          (id_contrato, numero, tipo, valor_mensal_novo, valor_total_novo,
           descricao, status, id_user_criou)
        VALUES (@id, @num, 'REAJUSTE', @vm, @vt, @desc, 'RASCUNHO', @uid)
        RETURNING id`,
        { id, num: numero, vm: novoMensal, vt: novoTotal, desc: descricao, uid: user?.ID || null }
      );

      Auditoria.registrar(app, {
        modulo: 'ApoioGerencial', submodulo: 'Contratos',
        acao: 'REAJUSTE_GERADO', severidade: 'INFO',
        req, entidade: 'contrato_aditivo', entidadeId: String(ins[0].id),
        descricao: `Aditivo de reajuste ${numero} gerado em RASCUNHO — ${descricao}`,
        meta: { contrato_id: id, aditivo_id: ins[0].id, indice: c.indice_reajuste, percentual, valor_mensal_novo: novoMensal, valor_total_novo: novoTotal }
      });

      return res.json({
        ok: true,
        aditivo_id: ins[0].id,
        numero,
        percentual_aplicado: percentual,
        valor_mensal_novo: novoMensal,
        valor_total_novo: novoTotal,
        proximo_passo: 'Aprove o aditivo pra aplicar os novos valores no contrato (PUT /aditivos/:aid/aprovar)'
      });
    } catch (err) {
      console.error('reajuste-aplicar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});

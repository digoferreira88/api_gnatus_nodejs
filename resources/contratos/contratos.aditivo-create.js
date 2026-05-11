// POST /contratos/:id/aditivos — cria aditivo (status inicial: RASCUNHO)
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([5003]);
const Auditoria = require('../../services/auditoria');

const trim = (v) => v == null ? null : String(v).trim() || null;
const toN  = (v) => (v == null || v === '') ? null : Number(v);
const toDate = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(v)) ? v.slice(0, 10) : null;

const TIPOS_VALIDOS = ['VALOR', 'PRAZO', 'ESCOPO', 'REAJUSTE', 'MISTO'];

module.exports = (app) => ({
  verb: 'post',
  route: '/:id/aditivos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'id invalido.' });
    const b = req.body || {};
    const tipoAdit = trim(b.tipo);
    if (!TIPOS_VALIDOS.includes(tipoAdit)) {
      return res.status(400).json({ message: 'tipo invalido. Use ' + TIPOS_VALIDOS.join('/') });
    }
    try {
      // Verifica que o contrato existe
      const cur = await Pg.connectAndQuery(`SELECT id, numero FROM tab_contrato WHERE id = @id`, { id });
      if (!cur.length) return res.status(404).json({ message: 'Contrato nao encontrado.' });

      // Proximo numero do aditivo (sequencial)
      const ult = await Pg.connectAndQuery(
        `SELECT COUNT(*) qt FROM tab_contrato_aditivo WHERE id_contrato = @id`, { id }
      );
      const numero = `${Number(ult[0]?.qt || 0) + 1}`;

      const r = await Pg.connectAndQuery(`
        INSERT INTO tab_contrato_aditivo
          (id_contrato, numero, tipo, data_assinatura,
           valor_total_novo, valor_mensal_novo, vigencia_fim_novo,
           descricao, status, id_user_criou)
        VALUES (@id, @num, @tipo, @dt::date, @vt, @vm, @vf::date, @desc, 'RASCUNHO', @uid)
        RETURNING id`,
        {
          id, num: numero, tipo: tipoAdit,
          dt: toDate(b.data_assinatura),
          vt: toN(b.valor_total_novo), vm: toN(b.valor_mensal_novo),
          vf: toDate(b.vigencia_fim_novo),
          desc: trim(b.descricao),
          uid: user?.ID || null
        }
      );

      Auditoria.registrar(app, {
        modulo: 'ApoioGerencial', submodulo: 'Contratos',
        acao: 'ADITIVO_CREATE', severidade: 'INFO',
        req, entidade: 'contrato_aditivo', entidadeId: String(r[0].id),
        descricao: `Criou aditivo ${numero}/${tipoAdit} no contrato ${cur[0].numero}`,
        meta: { contrato_id: id, aditivo_id: r[0].id, tipo: tipoAdit }
      });

      return res.json({ ok: true, id: r[0].id, numero });
    } catch (err) {
      console.error('aditivo-create:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
